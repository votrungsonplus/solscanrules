const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'bundle_limit',
  name: 'Bundle Limit',
  description: 'Bundle phải < 20% total supply',
  enabled: true,
  type: 'REQUIRE',
  maxPercent: 20,
  evaluate: (ctx) => {
    const { holderStats } = ctx;
    if (!holderStats) return { passed: false, reason: '⚠️ Không có dữ liệu holder để đánh giá Bundle' };
    if (holderStats.dataInvalid) {
      return { passed: false, reason: '⚠️ Dữ liệu holder không hợp lệ' };
    }

    const max = ctx.rule?.maxPercent || settings.rules.maxPercentBundle || 20;
    const actual = holderStats.bundleHoldPercent;
    const passed = actual < max;
    return {
      passed,
      reason: passed
        ? `Bundle nắm ${actual.toFixed(1)}% supply (< ${max}%)`
        : `Bundle nắm quá cao: ${actual.toFixed(1)}% supply (> ${max}%)`,
    };
  },
});
