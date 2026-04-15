const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'sybil_protection',
  name: 'Sybil Protection',
  description: 'Chống chia nhỏ ví (Top 10 holder phải nắm ít nhất 15%)',
  enabled: true,
  type: 'BLOCK',
  minPercent: settings.rules.minPercentTop10,
  evaluate: (ctx) => {
    const { holderStats } = ctx;
    if (!holderStats || holderStats.dataInvalid) {
      return { passed: true, reason: '⚠️ Không đủ dữ liệu holder để xác định Sybil' };
    }

    const min = ctx.rule?.minPercent || settings.rules.minPercentTop10;
    const actual = holderStats.top10Percent;
    const passed = actual >= min;

    return {
      passed,
      reason: passed
        ? `Top 10 nắm ${actual.toFixed(1)}% supply (>= ${min}% - Không có dấu hiệu Sybil)`
        : `⚠️ Dấu hiệu Sybil: Top 10 hội tụ quá thấp (${actual.toFixed(1)}% < ${min}%), có thể đã chia nhỏ ví để lừa người mua`,
    };
  },
});
