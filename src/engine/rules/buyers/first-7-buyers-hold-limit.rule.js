const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'first_7_buyers_hold_limit',
  name: 'First 7 Buyers Hold Limit',
  description: 'Chặn nếu 7 lệnh mua đầu tiên chiếm > 25% tổng cung',
  enabled: true,
  type: 'BLOCK',
  maxPercent: settings.rules.maxPercentFirst7Buyers,
  evaluate: (ctx) => {
    const { earlyBuyerTrades, holderStats } = ctx;
    if (!earlyBuyerTrades || earlyBuyerTrades.length === 0) {
      return { passed: true, reason: 'Chưa có lệnh mua sớm' };
    }
    if (!holderStats || !holderStats.supply) {
      return { passed: false, reason: '⚠️ Thiếu dữ liệu tổng cung để tính toán %' };
    }

    const totalSupply = holderStats.supply;
    const first7 = earlyBuyerTrades.slice(0, 7);
    const totalTokens = first7.reduce((sum, t) => sum + (t.tokenAmount || 0), 0);
    const actualPercent = (totalTokens / totalSupply) * 100;
    const max = ctx.rule?.maxPercent || settings.rules.maxPercentFirst7Buyers || 25;

    const passed = actualPercent <= max;
    return {
      passed,
      reason: passed
        ? `7 lệnh đầu nắm ${actualPercent.toFixed(2)}% cung (<= ${max}%)`
        : `7 lệnh đầu nắm quá cao: ${actualPercent.toFixed(2)}% cung (> ${max}%)`,
      data: { first7Percent: actualPercent },
    };
  },
});
