const settings = require('../../../config/settings');

/**
 * Rule: Launch MCap Ceiling
 *
 * Chặn pass khi MCap đã quá cao tại thời điểm pass (>250 SOL).
 *
 * Lý do (data-driven):
 *   - 1010/2205 (46%) pass token có ATH = launch_mcap (pump-then-dump tại đỉnh).
 *   - MCap >250 SOL tại pass = đã vào sau wave đầu, ROI trung bình kém.
 *   - Sweet spot 100–250 SOL cho win/dud tốt nhất.
 *
 * Đây là REQUIRE (hard fail), KHÔNG retryable — không có lý do MCap "giảm về"
 * lại ngưỡng thấp hơn mà vẫn pass.
 */
module.exports = () => ({
  id: 'launch_mcap_ceiling',
  name: 'Launch MCap Ceiling',
  description: 'Chặn nếu MCap đã quá cao tại lúc pass (mua sau đỉnh)',
  enabled: true,
  type: 'REQUIRE',
  maxMarketCapSol: settings.rules.maxMarketCapSol,

  evaluate: (ctx) => {
    const max = ctx.rule?.maxMarketCapSol || settings.rules.maxMarketCapSol;
    const actual = ctx.tokenData?.marketCapSol || 0;
    const passed = actual <= max;
    return {
      passed,
      reason: passed
        ? `MCap ${actual.toFixed(1)} SOL <= ${max} SOL ✓`
        : `🚫 MCap ${actual.toFixed(1)} SOL > ${max} SOL — đã quá đỉnh`,
      data: { marketCapSol: actual, maxMarketCapSol: max },
    };
  },
});
