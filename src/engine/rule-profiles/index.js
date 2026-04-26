const settings = require('../../config/settings');

const PROFILE_DEFINITIONS = {
  strict_current: {
    id: 'strict_current',
    name: 'Cấu hình mặc định (Data-Optimized)',
    description: 'Bộ lọc đã được tối ưu dựa trên phân tích 2.2k pass thực tế. Mục tiêu: dud rate ≤25%, win 2x ≥30%.',
    monitoring: {
      earlyBuyersToMonitor: 10,
      minBuyersToPass: 5,
      globalFeeThreshold: 0.3,
      showAllEarlyBuyers: false,
    },
    rules: {
      // Same buy amount: data cho thấy "cabal_signal" = 34% dud (xấu hơn baseline) → BLOCK
      same_buy_amount: { enabled: true, tolerancePercent: 10 },
      global_fee_threshold: { enabled: true, minGlobalFee: 0.3 },
      // Cluster detection: bị tắt vì data hiện tại có quá ít cluster signal trong pass
      cluster_detection: { enabled: false, minSharedFunders: 2 },
      // Sybil bật lại: <15% top10 = 51% dud (tệ nhất)
      sybil_protection: { enabled: true, minPercent: 15 },
      // Top10 max nới về 50 (sweet spot 15-50%)
      top10_holder_limit: { enabled: true, maxPercent: 50 },
      // Dev hold siết về 30 (đa số <2%, >30% là red flag)
      dev_hold_limit: { enabled: true, maxPercent: 30 },
      // Bundle siết về 10 (5-10% là sweet spot, >10% rủi ro)
      bundle_limit: { enabled: true, maxPercent: 10 },
      volume_threshold: { enabled: true, minVol: 90 },
      listing_age_limit: { enabled: true, maxMinutes: 8 },
      // MCap floor 100 (loại 80-100 SOL: 35% dud)
      market_cap_check: { enabled: true, minMarketCapSol: 100 },
      // Mới: trần MCap 250 — chặn pass đã quá đỉnh
      launch_mcap_ceiling: { enabled: true, maxMarketCapSol: 250 },
      // Mới: chặn whale concentration (>15 SOL từ early buyers = 42% dud)
      whale_buy_concentration: { enabled: true, maxTotalSol: 15 },
      dev_risk_check: { enabled: true, maxRiskScore: 50 },
      token_score_check: { enabled: false, minScore: 40 },
      bonding_curve_progress: { enabled: false, maxProgressPercent: 80 },

      new_wallet_accumulation: { enabled: true, checkFirstXBuyers: 5, maxAccumulationPercent: 25, includeBundleAsNew: true },
      first_7_buyers_hold_limit: { enabled: true, maxPercent: 25 },
      early_buyer_count_check: { enabled: true, minCount: 5 },
      new_wallet_total_hold_limit: { enabled: true, maxPercent: 15, includeBundleAsNew: true },
    },
  },
};

function getRuleProfiles() {
  return Object.values(PROFILE_DEFINITIONS);
}

function getRuleProfile(profileId) {
  return PROFILE_DEFINITIONS[profileId] || null;
}

function applyRuleProfile(ruleEngine, profileId) {
  const profile = getRuleProfile(profileId);
  if (!profile) throw new Error(`Unknown rule profile: ${profileId}`);

  ruleEngine.resetToDefaults();

  if (profile.monitoring) {
    Object.assign(settings.monitoring, profile.monitoring);
  }

  for (const [ruleId, overrides] of Object.entries(profile.rules || {})) {
    ruleEngine.updateRule(ruleId, overrides);
  }

  ruleEngine.setActiveProfile(profile.id);
  return profile;
}

function persistAppliedRuleProfile(tracker, ruleEngine, profileId) {
  tracker.saveBotSetting('activeRuleProfile', profileId);
  tracker.saveBotSetting('earlyBuyersToMonitor', settings.monitoring.earlyBuyersToMonitor);
  tracker.saveBotSetting('minBuyersToPass', settings.monitoring.minBuyersToPass);
  tracker.saveBotSetting('globalFeeThreshold', settings.monitoring.globalFeeThreshold);
  tracker.saveBotSetting('showAllEarlyBuyers', settings.monitoring.showAllEarlyBuyers);

  for (const rule of ruleEngine.getRules()) {
    tracker.saveRuleState(rule.id, rule.enabled);
    for (const [key, value] of Object.entries(rule)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        tracker.saveBotSetting(`rule_${rule.id}_${key}`, value);
      }
    }
  }
}

function markProfileAsCustom(tracker, ruleEngine) {
  ruleEngine.setActiveProfile('custom');
  tracker.saveBotSetting('activeRuleProfile', 'custom');
}

module.exports = {
  applyRuleProfile,
  getRuleProfile,
  getRuleProfiles,
  markProfileAsCustom,
  persistAppliedRuleProfile,
};
