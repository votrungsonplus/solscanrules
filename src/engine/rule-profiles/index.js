const settings = require('../../config/settings');

const PROFILE_DEFINITIONS = {
  strict_current: {
    id: 'strict_current',
    name: 'Cấu hình mặc định',
    description: 'Bộ lọc duy nhất — gắt nhất, ưu tiên lọc sạch.',
    monitoring: {
      earlyBuyersToMonitor: 10,
      minBuyersToPass: 5,
      globalFeeThreshold: 0.5,
      showAllEarlyBuyers: false,
    },
    rules: {
      same_buy_amount: { enabled: true, tolerancePercent: 10 },
      global_fee_threshold: { enabled: true, minGlobalFee: 0.5 },
      cluster_detection: { enabled: true, minSharedFunders: 2 },
      sybil_protection: { enabled: true, minPercent: 15 },
      top10_holder_limit: { enabled: true, maxPercent: 25 },
      dev_hold_limit: { enabled: true, maxPercent: 20 },
      bundle_limit: { enabled: true, maxPercent: 20 },
      volume_threshold: { enabled: true, minVol: 30 },
      listing_age_limit: { enabled: true, maxMinutes: 5 },
      market_cap_check: { enabled: true, minMarketCapSol: 80 },
      dev_risk_check: { enabled: true, maxRiskScore: 50 },
      token_score_check: { enabled: false, minScore: 40 },
      bonding_curve_progress: { enabled: false, maxProgressPercent: 80 },

      new_wallet_accumulation: { enabled: true, checkFirstXBuyers: 5, maxAccumulationPercent: 20, includeBundleAsNew: true },
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
