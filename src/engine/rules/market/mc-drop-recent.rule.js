/**
 * Rule: Market Cap Drop Recent
 *
 * BLOCK nếu MC hiện tại đã giảm > X% so với peak gần nhất (token đã chết / dump phase).
 *
 * Yêu cầu peak MC tracking — orchestrator track `tokenMcPeak.get(mint)` mỗi khi
 * marketCapSol cập nhật, lưu cao nhất từ lúc detect.
 */
module.exports = () => ({
  id: 'mc_drop_recent',
  name: 'MC Drop Recent',
  description: 'Chặn nếu MC giảm > ngưỡng từ peak (token đang dump)',
  enabled: process.env.RULE_MC_DROP_ENABLED !== 'false',
  type: 'BLOCK',
  // % drop tối đa cho phép. Mặc định 30% — nếu giảm hơn 30% từ peak là dấu hiệu chết.
  maxDropPercent: parseFloat(process.env.RULE_MC_DROP_MAX_PCT || '30'),
  // Yêu cầu peak ≥ ngưỡng SOL để có ý nghĩa (token tự đu đỉnh thấp không cần block)
  minPeakSol: parseFloat(process.env.RULE_MC_DROP_MIN_PEAK_SOL || '50'),
  retryable: false,

  evaluate: (ctx) => {
    const current = ctx.tokenData?.marketCapSol || 0;
    const peak = ctx.tokenData?.peakMarketCapSol || 0;
    const minPeak = ctx.rule?.minPeakSol ?? 50;
    const maxDrop = ctx.rule?.maxDropPercent ?? 30;

    if (peak < minPeak || current <= 0) {
      return {
        passed: true,
        reason: `Chưa đủ peak để đánh giá (peak ${peak.toFixed(1)} SOL < ${minPeak})`,
        data: { current, peak, dropPercent: 0 },
      };
    }

    const dropPercent = ((peak - current) / peak) * 100;
    const passed = dropPercent <= maxDrop;

    return {
      passed,
      reason: passed
        ? `MC ${current.toFixed(1)} SOL (peak ${peak.toFixed(1)}, giảm ${dropPercent.toFixed(1)}% ≤ ${maxDrop}%) ✓`
        : `🚫 Token đang dump: MC ${current.toFixed(1)} SOL — giảm ${dropPercent.toFixed(1)}% từ peak ${peak.toFixed(1)} (> ${maxDrop}%)`,
      data: { current, peak, dropPercent, maxDropPercent: maxDrop },
    };
  },
});
