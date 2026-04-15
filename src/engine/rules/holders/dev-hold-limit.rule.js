const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'dev_hold_limit',
  name: 'Dev Hold Limit',
  description: 'Dev hold phải < 20% total supply',
  enabled: true,
  type: 'REQUIRE',
  maxPercent: settings.rules.maxPercentDev,
  evaluate: (ctx) => {
    const { holderStats } = ctx;
    if (!holderStats) return { passed: false, reason: '⚠️ Không có dữ liệu holder để đánh giá Dev Hold' };
    if (holderStats.dataInvalid) {
      return { passed: false, reason: '⚠️ Dữ liệu holder không hợp lệ' };
    }

    const max = ctx.rule?.maxPercent || settings.rules.maxPercentDev;
    const actual = holderStats.devHoldPercent;
    const passed = actual < max;
    return {
      passed,
      reason: passed
        ? `Dev nắm ${actual.toFixed(1)}% supply (< ${max}%)`
        : `Dev nắm quá cao: ${actual.toFixed(1)}% supply (> ${max}%)`,
    };
  },
});
