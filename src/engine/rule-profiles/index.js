const settings = require('../../config/settings');

const PROFILE_DEFINITIONS = {
  strict_current: {
    id: 'strict_current',
    name: 'Strict Current',
    description: 'Preset gắt nhất, gần với logic current để ưu tiên lọc sạch.',
    monitoring: {
      earlyBuyersToMonitor: 10,
      minBuyersToPass: 5,
      globalFeeThreshold: 0.5,
      showAllEarlyBuyers: false,
    },
    rules: {
      same_buy_amount: { enabled: true, tolerancePercent: 10 },
      global_fee_threshold: { enabled: true, minGlobalFee: 0.5 },
      cluster_detection: { enabled: true, minSharedFunders: 3 },
      sybil_protection: { enabled: true, minPercent: 15 },
      top10_holder_limit: { enabled: true, maxPercent: 25 },
      dev_hold_limit: { enabled: true, maxPercent: 20 },
      bundle_limit: { enabled: true, maxPercent: 20 },
      volume_threshold: { enabled: true, minVol: 30 },
      listing_age_limit: { enabled: true, maxMinutes: 5 },
      market_cap_check: { enabled: true, minMarketCapSol: 10 },
      dev_risk_check: { enabled: true, maxRiskScore: 50 },
      token_score_check: { enabled: false, minScore: 40 },
      bonding_curve_progress: { enabled: false, maxProgressPercent: 80 },

      new_wallet_accumulation: { enabled: true, checkFirstXBuyers: 5, maxAccumulationPercent: 10, includeBundleAsNew: true },
      first_7_buyers_hold_limit: { enabled: true, maxPercent: 25 },
      early_buyer_count_check: { enabled: true, minCount: 5 },
    },
  },
  balanced_backup3: {
    id: 'balanced_backup3',
    name: 'Balanced Backup3',
    description: 'Preset cân bằng, gần với backup3 và cũng là hướng gần backup2.1 nhất.',
    monitoring: {
      earlyBuyersToMonitor: 10,
      minBuyersToPass: 5,
      globalFeeThreshold: 0.3,
      showAllEarlyBuyers: true,
    },
    rules: {
      same_buy_amount: { enabled: true, tolerancePercent: 10 },
      global_fee_threshold: { enabled: true, minGlobalFee: 0.3 },
      cluster_detection: { enabled: true, minSharedFunders: 3 },
      sybil_protection: { enabled: false, minPercent: 15 },
      top10_holder_limit: { enabled: true, maxPercent: 30 },
      dev_hold_limit: { enabled: true, maxPercent: 20 },
      bundle_limit: { enabled: true, maxPercent: 20 },
      volume_threshold: { enabled: true, minVol: 30 },
      listing_age_limit: { enabled: true, maxMinutes: 5 },
      market_cap_check: { enabled: true, minMarketCapSol: 10 },
      dev_risk_check: { enabled: true, maxRiskScore: 60 },
      token_score_check: { enabled: false, minScore: 40 },
      bonding_curve_progress: { enabled: false, maxProgressPercent: 80 },

      new_wallet_accumulation: { enabled: true, checkFirstXBuyers: 5, maxAccumulationPercent: 15, includeBundleAsNew: true },
      first_7_buyers_hold_limit: { enabled: true, maxPercent: 25 },
      early_buyer_count_check: { enabled: true, minCount: 5 },
    },
  },
  loose_backup2: {
    id: 'loose_backup2',
    name: 'Loose Backup2',
    description: 'Preset thoáng hơn để tăng số kèo, gần với tinh thần backup2.',
    monitoring: {
      earlyBuyersToMonitor: 5,
      minBuyersToPass: 5,
      globalFeeThreshold: 0.3,
      showAllEarlyBuyers: true,
    },
    rules: {
      same_buy_amount: { enabled: true, tolerancePercent: 10 },
      global_fee_threshold: { enabled: true, minGlobalFee: 0.3 },
      cluster_detection: { enabled: true, minSharedFunders: 3 },
      sybil_protection: { enabled: false, minPercent: 15 },
      top10_holder_limit: { enabled: true, maxPercent: 30 },
      dev_hold_limit: { enabled: true, maxPercent: 20 },
      bundle_limit: { enabled: true, maxPercent: 20 },
      volume_threshold: { enabled: true, minVol: 30 },
      listing_age_limit: { enabled: true, maxMinutes: 5 },
      market_cap_check: { enabled: true, minMarketCapSol: 10 },
      dev_risk_check: { enabled: true, maxRiskScore: 60 },
      token_score_check: { enabled: false, minScore: 40 },
      bonding_curve_progress: { enabled: false, maxProgressPercent: 80 },

      new_wallet_accumulation: { enabled: true, checkFirstXBuyers: 5, maxAccumulationPercent: 20, includeBundleAsNew: true },
      first_7_buyers_hold_limit: { enabled: false, maxPercent: 25 },
      early_buyer_count_check: { enabled: false, minCount: 5 },
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
