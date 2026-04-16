const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'top10_holder_limit',
  name: 'Top 10 Holder Limit',
  description: 'Top 10 holder phải < 30% total supply (trừ pool khỏi DS holder)',
  enabled: true,
  type: 'REQUIRE',
  maxPercent: settings.rules.maxPercentTop10,
  retryable: true,
  evaluate: (ctx) => {
    const { holderStats } = ctx;
    if (!holderStats) return { passed: false, reason: '⚠️ Không có dữ liệu holder để đánh giá Top 10' };
    if (holderStats.dataInvalid) {
      return { passed: false, reason: '⚠️ Dữ liệu holder không hợp lệ hoặc không nhất quán' };
    }

    const max = ctx.rule?.maxPercent || settings.rules.maxPercentTop10;
    const actual = holderStats.top10Percent;
    const passed = actual < max;
    const ownersActual = holderStats.top10OwnersPercent;

    return {
      passed,
      retryable: !passed,
      reason: passed
        ? `Top 10 nắm ${actual.toFixed(1)}% supply${holderStats.top10CirculatingPercent ? ` (Circulating: ${holderStats.top10CirculatingPercent.toFixed(1)}%)` : ''} (< ${max}%)${holderStats.preliminary ? ' | preliminary' : ''}${typeof ownersActual === 'number' ? ` | Owners: ${ownersActual.toFixed(1)}%` : ''}`
        : `Top 10 nắm quá cao: ${actual.toFixed(1)}% supply${holderStats.top10CirculatingPercent ? ` (Circulating: ${holderStats.top10CirculatingPercent.toFixed(1)}%)` : ''} (> ${max}%)${holderStats.preliminary ? ' | preliminary' : ''}${typeof ownersActual === 'number' ? ` | Owners: ${ownersActual.toFixed(1)}%` : ''}`,
    };
  },
});
