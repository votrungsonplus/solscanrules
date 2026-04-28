// MEV / Arb / Sandwich bot detection.
// Tách logic ra khỏi orchestrator để dễ test và mở rộng.
//
// Các tín hiệu detect:
//   1. Round-trip: cùng trader có buy + sell cùng mint trong < N giây → MEV/sandwich
//   2. Known signer blacklist: env-driven list của Jito searcher đã biết
//   3. Heuristic high-frequency: tx count quá lớn trong wallet age ngắn

const { isJitoTipAccount } = require('../config/jito.constants');

const ENV_KNOWN_MEV = (process.env.KNOWN_MEV_SIGNERS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Placeholder — user nên mở rộng qua env. Một số signer Jito searcher phổ biến.
const KNOWN_MEV_SIGNERS = new Set(ENV_KNOWN_MEV);

const ROUNDTRIP_WINDOW_MS = parseInt(process.env.MEV_ROUNDTRIP_WINDOW_MS || '5000', 10);
const HIGH_FREQ_TX_PER_HOUR = parseInt(process.env.MEV_HIGH_FREQ_TX_PER_HOUR || '100', 10);

/**
 * Phát hiện MEV roundtrip từ lịch sử trade của 1 token.
 * tradeHistory: array of { trader, type ('buy'|'sell'), ts, signature }
 * Returns: Set<traderAddress> các ví có roundtrip < windowMs
 */
function detectRoundtripMEV(tradeHistory, windowMs = ROUNDTRIP_WINDOW_MS) {
  const mevSet = new Set();
  if (!Array.isArray(tradeHistory) || tradeHistory.length < 2) return mevSet;

  // Group by trader
  const byTrader = new Map();
  for (const t of tradeHistory) {
    if (!t.trader || !t.type) continue;
    if (!byTrader.has(t.trader)) byTrader.set(t.trader, []);
    byTrader.get(t.trader).push(t);
  }

  for (const [trader, trades] of byTrader.entries()) {
    if (trades.length < 2) continue;
    trades.sort((a, b) => (a.ts || 0) - (b.ts || 0));

    // Check buy → sell trong cùng window
    let lastBuyTs = null;
    for (const t of trades) {
      if (t.type === 'buy') {
        lastBuyTs = t.ts;
      } else if (t.type === 'sell' && lastBuyTs && (t.ts - lastBuyTs) < windowMs) {
        mevSet.add(trader);
        break;
      }
    }
  }

  return mevSet;
}

/**
 * Heuristic: ví bot tần suất cao.
 * walletAnalysis: kết quả từ walletAnalyzer.analyzeWallet()
 *   - txCount: số signatures fetch được (cap ở sigLookupLimit)
 *   - walletAgeSeconds: tuổi ví (Infinity nếu maxed out)
 */
function isLikelyHighFreqBot(walletAnalysis) {
  if (!walletAnalysis) return false;
  const tx = walletAnalysis.txCount || 0;
  const ageSec = walletAnalysis.walletAgeSeconds;
  if (!Number.isFinite(ageSec) || ageSec <= 0) return false;
  const hours = ageSec / 3600;
  if (hours <= 0) return false;
  const txPerHour = tx / hours;
  return txPerHour >= HIGH_FREQ_TX_PER_HOUR;
}

/**
 * Combined: phát hiện ví MEV/bot trong list early buyer.
 * Returns: { mevWallets: Set, reasons: Map<addr, string[]> }
 */
function detectBots({ tradeHistory, earlyBuyerAnalyses }) {
  const mevWallets = new Set();
  const reasons = new Map();

  const addReason = (addr, r) => {
    if (!reasons.has(addr)) reasons.set(addr, []);
    reasons.get(addr).push(r);
    mevWallets.add(addr);
  };

  // 1. Roundtrip
  const rt = detectRoundtripMEV(tradeHistory);
  for (const addr of rt) addReason(addr, `roundtrip < ${ROUNDTRIP_WINDOW_MS}ms`);

  // 2. Known signer blacklist
  if (Array.isArray(earlyBuyerAnalyses)) {
    for (const w of earlyBuyerAnalyses) {
      if (KNOWN_MEV_SIGNERS.has(w.address)) {
        addReason(w.address, 'known MEV signer');
      }
      if (isLikelyHighFreqBot(w)) {
        addReason(w.address, `high-freq (≥ ${HIGH_FREQ_TX_PER_HOUR} tx/h)`);
      }
    }
  }

  return { mevWallets, reasons };
}

module.exports = {
  KNOWN_MEV_SIGNERS,
  ROUNDTRIP_WINDOW_MS,
  HIGH_FREQ_TX_PER_HOUR,
  detectRoundtripMEV,
  isLikelyHighFreqBot,
  detectBots,
  isJitoTipAccount, // re-export tiện cho rule
};
