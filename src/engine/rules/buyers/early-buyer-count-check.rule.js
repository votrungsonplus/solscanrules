const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'early_buyer_count_check',
  name: 'Early Buyer Count Check',
  description: 'Đảm bảo có đủ số lượng người mua tối thiểu để phân tích',
  enabled: true,
  type: 'BLOCK',
  minCount: settings.monitoring.minBuyersToPass,
  evaluate: (ctx) => {
    const { earlyBuyers } = ctx;
    const count = earlyBuyers.length;
    const min = ctx.rule?.minCount || settings.monitoring.minBuyersToPass || 5;

    const passed = count >= min;
    return {
      passed,
      reason: passed
        ? `Đã đạt tối thiểu ${min} ví mua sớm (${count}/${min})`
        : `Chưa đủ ${min} ví mua sớm (${count}/${min})`,
      data: { buyerCount: count, minRequired: min },
    };
  },
});
