const settings = require('../../../config/settings');

/**
 * Rule: Whale Buy Concentration
 *
 * Chặn nếu tổng SOL mà các early buyers (≤10 ví) đã mua > ngưỡng.
 *
 * Lý do (data-driven):
 *   - Tổng SOL <1: dud 24%, win 30% (organic, ít cá voi)
 *   - Tổng SOL 1-15: dud 28-31%, win 24-27% (bình thường)
 *   - Tổng SOL >20: dud 42%, win 28% (cá voi đẩy đỉnh rồi rút)
 *
 * Cá voi mua sớm thường là người dump trước, để lại retail bag-hold.
 * Block sớm tránh đua với họ.
 */
module.exports = () => ({
  id: 'whale_buy_concentration',
  name: 'Whale Buy Concentration',
  description: 'Chặn nếu tổng SOL của các early buyers vượt ngưỡng (cá voi tích trữ)',
  enabled: true,
  type: 'BLOCK',
  maxTotalSol: settings.rules.whaleMaxTotalSol,

  evaluate: (ctx) => {
    const allTrades = ctx.earlyBuyerTrades || [];
    if (allTrades.length === 0) {
      return { passed: true, reason: 'Chưa có early buyer trade để đánh giá' };
    }

    // Loại MEV/bot khỏi tập tính whale (roundtrip < 5s = MEV, không phải retail/insider).
    // mevWallets được compute ở Phase 5 (bot-detector.detectBots) và pass vào ctx.
    const mevSet = ctx.mevWallets instanceof Set ? ctx.mevWallets : new Set(ctx.mevWallets || []);
    const trades = mevSet.size > 0
      ? allTrades.filter(t => !mevSet.has(t.trader))
      : allTrades;
    const mevExcluded = allTrades.length - trades.length;

    const max = ctx.rule?.maxTotalSol || settings.rules.whaleMaxTotalSol;
    const total = trades.reduce((s, t) => s + (Number(t.solAmount) || 0), 0);
    const passed = total < max;
    const mevSuffix = mevExcluded > 0 ? ` (loại ${mevExcluded} ví MEV)` : '';

    if (passed) {
      return {
        passed: true,
        reason: `Tổng SOL early buyers ${total.toFixed(2)} < ${max}${mevSuffix} ✓`,
        data: { totalSol: total, maxTotalSol: max, buyerCount: trades.length, mevExcluded },
      };
    }

    const sortedTrades = [...trades].sort((a, b) => (b.solAmount || 0) - (a.solAmount || 0));
    let detail = `🐋 Whale concentration: ${total.toFixed(2)} SOL từ ${trades.length} ví${mevSuffix} (>= ${max} SOL)`;
    for (const t of sortedTrades.slice(0, 3)) {
      const addr = String(t.trader || '');
      const short = addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
      detail += `\n  → ${short} | ${(t.solAmount || 0).toFixed(3)} SOL`;
    }

    return {
      passed: false,
      reason: detail,
      data: { totalSol: total, maxTotalSol: max, buyerCount: trades.length, mevExcluded },
    };
  },
});
