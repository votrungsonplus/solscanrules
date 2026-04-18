const whiteWalletFromDeployerRule = require('./signals/white-wallet-from-deployer.rule');
const whiteWalletFromCexRule = require('./signals/white-wallet-from-cex.rule');
const sameBuyAmountRule = require('./buyers/same-buy-amount.rule');
const globalFeeThresholdRule = require('./market/global-fee-threshold.rule');
const clusterDetectionRule = require('./signals/cluster-detection.rule');
const sybilProtectionRule = require('./holders/sybil-protection.rule');
const top10HolderLimitRule = require('./holders/top10-holder-limit.rule');
const devHoldLimitRule = require('./holders/dev-hold-limit.rule');
const bundleLimitRule = require('./holders/bundle-limit.rule');
const volumeThresholdRule = require('./market/volume-threshold.rule');
const listingAgeLimitRule = require('./market/listing-age-limit.rule');
const marketCapCheckRule = require('./market/market-cap-check.rule');
const devRiskCheckRule = require('./quality/dev-risk-check.rule');
const tokenScoreCheckRule = require('./quality/token-score-check.rule');
const bondingCurveProgressRule = require('./market/bonding-curve-progress.rule');
const newWalletAccumulationRule = require('./buyers/new-wallet-accumulation.rule');
const first7BuyersHoldLimitRule = require('./buyers/first-7-buyers-hold-limit.rule');
const earlyBuyerCountCheckRule = require('./buyers/early-buyer-count-check.rule');
const newWalletTotalHoldLimitRule = require('./buyers/new-wallet-total-hold-limit.rule');

function buildDefaultRules() {
  return [
    whiteWalletFromDeployerRule(),
    whiteWalletFromCexRule(),
    sameBuyAmountRule(),
    globalFeeThresholdRule(),
    clusterDetectionRule(),
    sybilProtectionRule(),
    top10HolderLimitRule(),
    devHoldLimitRule(),
    bundleLimitRule(),
    volumeThresholdRule(),
    listingAgeLimitRule(),
    marketCapCheckRule(),
    devRiskCheckRule(),
    tokenScoreCheckRule(),
    bondingCurveProgressRule(),
    newWalletAccumulationRule(),
    first7BuyersHoldLimitRule(),
    earlyBuyerCountCheckRule(),
    // Final gate — đặt cuối cùng để hiển thị sau các rule khác
    newWalletTotalHoldLimitRule(),
  ];
}

module.exports = {
  buildDefaultRules,
};
