/**
 * ENV-SYNC — Đồng bộ 2 chiều: settings ↔ .env ↔ web dashboard
 *
 * Mỗi khi settings thay đổi (từ web hoặc startup DB restore),
 * module này ghi lại .env để file luôn phản ánh đúng giá trị đang chạy.
 *
 * Luồng:
 *   Startup:  .env → settings.js → DB override → env-sync ghi lại .env
 *   Web:      user thay đổi → settings + DB + env-sync ghi lại .env
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const ENV_PATH = path.resolve(__dirname, '../../.env');

/**
 * Bản đồ: ENV_KEY → cách đọc giá trị hiện tại từ settings object
 * Đây là nguồn sự thật duy nhất cho mapping giữa .env key và settings path.
 */
function getEnvMap(settings, ruleEngine) {
  // Lấy rule values hiện tại từ rule engine (đã bao gồm DB overrides + web changes)
  const ruleValues = {};
  if (ruleEngine) {
    for (const rule of ruleEngine.getRules()) {
      for (const [key, value] of Object.entries(rule)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          ruleValues[`${rule.id}.${key}`] = value;
        }
      }
    }
  }

  const rv = (ruleId, param, fallback) => {
    const key = `${ruleId}.${param}`;
    return ruleValues[key] !== undefined ? ruleValues[key] : fallback;
  };

  return {
    // ── Trading ──
    AUTO_BUY_ENABLED: String(settings.trading.autoBuyEnabled),
    AUTO_SELL_ENABLED: String(settings.trading.autoSellEnabled),
    BUY_AMOUNT_SOL: String(settings.trading.buyAmountSol),
    MAX_CONCURRENT_POSITIONS: String(settings.trading.maxConcurrentPositions),
    DAILY_LOSS_LIMIT_SOL: String(settings.trading.dailyLossLimitSol),
    BUY_SLIPPAGE: String(settings.trading.buySlippage),
    SELL_SLIPPAGE: String(settings.trading.sellSlippage),

    // ── Risk ──
    TAKE_PROFIT_PERCENT: String(settings.risk.takeProfitPercent),
    STOP_LOSS_PERCENT: String(settings.risk.stopLossPercent),

    // ── Monitoring ──
    EARLY_BUYERS_TO_MONITOR: String(settings.monitoring.earlyBuyersToMonitor),
    MIN_BUYERS_TO_PASS: String(settings.monitoring.minBuyersToPass),
    GLOBAL_FEE_THRESHOLD: String(settings.monitoring.globalFeeThreshold),
    SHOW_ALL_EARLY_BUYERS: String(settings.monitoring.showAllEarlyBuyers),

    // ── Rule Thresholds (đồng bộ từ rule engine) ──
    RULE_MIN_MC_SOL: String(rv('market_cap_check', 'minMarketCapSol', settings.rules.minMarketCapSol)),
    RULE_MAX_AGE_MIN: String(rv('listing_age_limit', 'maxMinutes', settings.rules.maxMinutes)),
    RULE_TOP10_MAX_PCT: String(rv('top10_holder_limit', 'maxPercent', settings.rules.maxPercentTop10)),
    RULE_TOP10_MIN_PCT: String(rv('sybil_protection', 'minPercent', settings.rules.minPercentTop10)),
    RULE_DEV_HOLD_MAX_PCT: String(rv('dev_hold_limit', 'maxPercent', settings.rules.maxPercentDev)),
    RULE_BUNDLE_MAX_PCT: String(rv('bundle_limit', 'maxPercent', settings.rules.maxPercentBundle)),
    RULE_MIN_VOL_SOL: String(rv('volume_threshold', 'minVol', settings.rules.minVol)),
    RULE_MIN_GLOBAL_FEE: String(rv('global_fee_threshold', 'minGlobalFee', settings.rules.minGlobalFee)),
    RULE_MIN_FUNDERS: String(rv('cluster_detection', 'minSharedFunders', settings.rules.minSharedFunders)),
    RULE_MAX_RISK: String(rv('dev_risk_check', 'maxRiskScore', settings.rules.maxRiskScore)),
    RULE_MIN_SCORE: String(rv('token_score_check', 'minScore', settings.rules.minScore)),
    RULE_MAX_PROGRESS: String(rv('bonding_curve_progress', 'maxProgressPercent', settings.rules.maxProgressPercent)),
    RULE_MAX_PCT_7_BUYERS: String(rv('first_7_buyers_hold_limit', 'maxPercent', settings.rules.maxPercentFirst7Buyers)),
    RULE_TOLERANCE_PCT: String(rv('same_buy_amount', 'tolerancePercent', settings.rules.tolerancePercent)),
    RULE_ACCUMULATION_CHECK_X: String(rv('new_wallet_accumulation', 'checkFirstXBuyers', settings.rules.accumulationCheckFirstX)),
    RULE_ACCUMULATION_MAX_PCT: String(rv('new_wallet_accumulation', 'maxAccumulationPercent', settings.rules.accumulationMaxPercent)),
    RULE_NEW_WALLET_TOTAL_HOLD_MAX: String(rv('new_wallet_total_hold_limit', 'maxPercent', settings.rules.newWalletTotalHoldMaxPercent)),
    RULE_MAX_MC_SOL: String(rv('launch_mcap_ceiling', 'maxMarketCapSol', settings.rules.maxMarketCapSol)),
    RULE_WHALE_MAX_TOTAL_SOL: String(rv('whale_buy_concentration', 'maxTotalSol', settings.rules.whaleMaxTotalSol)),

    // ── Anti-top-buy guard ──
    ANTI_TOP_BUY_ENABLED: String(settings.antiTopBuy.enabled),
    ANTI_TOP_BUY_DELAY_MS: String(settings.antiTopBuy.delayMs),
    ANTI_TOP_BUY_MAX_DRIFT_PCT: String(settings.antiTopBuy.maxDriftPercent),

    // ── Holder cache TTL ──
    HOLDER_CACHE_TTL_MS: String(settings.holderCache.ttlMs),
  };
}

/**
 * Đọc .env hiện tại thành Map (giữ nguyên comments, thứ tự, secrets)
 */
function parseEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return { lines: [], map: new Map() };

  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  const lines = content.split('\n');
  const map = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.substring(0, eqIdx).trim();
    map.set(key, i); // line index
  }

  return { lines, map };
}

/**
 * Ghi đồng bộ settings hiện tại ra .env
 * Giữ nguyên: comments, secrets (RPC, wallet, telegram, etc.), thứ tự cấu trúc
 * Chỉ cập nhật/thêm các key có trong envMap
 */
function syncToEnv(settings, ruleEngine) {
  try {
    const envMap = getEnvMap(settings, ruleEngine);
    const { lines, map } = parseEnvFile();

    // Update existing keys
    const written = new Set();
    for (const [key, value] of Object.entries(envMap)) {
      if (map.has(key)) {
        // Update in-place
        lines[map.get(key)] = `${key}=${value}`;
        written.add(key);
      }
    }

    // Append any new keys that don't exist in .env yet
    const newKeys = Object.entries(envMap).filter(([k]) => !written.has(k));
    if (newKeys.length > 0) {
      // Find or create sections
      const ruleKeys = newKeys.filter(([k]) => k.startsWith('RULE_'));
      const tradingKeys = newKeys.filter(([k]) => !k.startsWith('RULE_'));

      if (tradingKeys.length > 0) {
        lines.push('');
        lines.push('# Bot Settings (auto-synced from Dashboard)');
        for (const [key, value] of tradingKeys) {
          lines.push(`${key}=${value}`);
        }
      }

      if (ruleKeys.length > 0) {
        lines.push('');
        lines.push('# ============================================');
        lines.push('# RULE THRESHOLDS (auto-synced from Dashboard)');
        lines.push('# Thay đổi ở đây hoặc trên Web đều đồng bộ');
        lines.push('# ============================================');
        for (const [key, value] of ruleKeys) {
          lines.push(`${key}=${value}`);
        }
      }
    }

    fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf-8');
    logger.debug('ENV-SYNC: .env file updated with current settings');
  } catch (err) {
    logger.warn(`ENV-SYNC: Failed to write .env — ${err.message}`);
  }
}

/**
 * Đọc .env hiện tại và trả về object so sánh: { key, envValue, liveValue, match }
 * Dùng cho debugging / hiển thị trên web
 */
function getComparisonTable(settings, ruleEngine) {
  const envMap = getEnvMap(settings, ruleEngine);
  const { lines, map } = parseEnvFile();

  const result = [];
  for (const [key, liveValue] of Object.entries(envMap)) {
    let envValue = null;
    if (map.has(key)) {
      const line = lines[map.get(key)];
      const eqIdx = line.indexOf('=');
      envValue = eqIdx >= 0 ? line.substring(eqIdx + 1).trim() : null;
    }
    result.push({
      key,
      envValue: envValue,
      liveValue: liveValue,
      match: envValue === liveValue,
      source: envValue === null ? 'DEFAULT' : (envValue === liveValue ? 'ENV' : 'DB/WEB'),
    });
  }
  return result;
}

module.exports = {
  syncToEnv,
  getEnvMap,
  getComparisonTable,
  ENV_PATH,
};
