/**
 * Rule: Wash Trade Ratio
 *
 * BLOCK nếu tỉ lệ uniqueBuyers / totalTrades quá thấp — dấu hiệu wash trade
 * (dev qua-lại giữa vài ví để pump volume + globalFee).
 *
 * Sử dụng `tokenTradeHistory` track trong Phase 5 (200 trade gần nhất per mint).
 * Yêu cầu tối thiểu 20 trade để tránh false positive ở token mới.
 */
module.exports = () => ({
  id: 'wash_trade_ratio',
  name: 'Wash Trade Ratio',
  description: 'Chặn nếu tỉ lệ unique trader / total trades quá thấp (wash trade)',
  enabled: process.env.RULE_WASH_TRADE_ENABLED !== 'false',
  type: 'BLOCK',
  // Ngưỡng: < 0.3 = wash. Vd 30 trade chỉ 5 ví thì ratio = 0.17 → block.
  minRatio: parseFloat(process.env.RULE_WASH_TRADE_MIN_RATIO || '0.3'),
  // Tối thiểu trade để có ý nghĩa thống kê
  minTrades: parseInt(process.env.RULE_WASH_TRADE_MIN_TRADES || '20', 10),

  evaluate: (ctx) => {
    const history = Array.isArray(ctx.tokenTradeHistory)
      ? ctx.tokenTradeHistory
      : (ctx.settings ? ctx.settings._tokenTradeHistoryCtx : null);

    // Fallback: lấy từ orchestrator nếu chưa pass vào context
    const trades = history || [];
    if (trades.length < (ctx.rule?.minTrades ?? 20)) {
      return {
        passed: true,
        reason: `Chưa đủ trade để đánh giá wash (${trades.length} trade)`,
        data: { totalTrades: trades.length, minTrades: ctx.rule?.minTrades ?? 20 },
      };
    }

    const uniqueTraders = new Set(trades.map(t => t.trader).filter(Boolean));
    const ratio = uniqueTraders.size / trades.length;
    const minRatio = ctx.rule?.minRatio ?? 0.3;
    const passed = ratio >= minRatio;

    return {
      passed,
      reason: passed
        ? `Wash ratio ${ratio.toFixed(2)} (${uniqueTraders.size}/${trades.length}) ≥ ${minRatio} ✓`
        : `🚫 Wash trade detected: ratio ${ratio.toFixed(2)} (${uniqueTraders.size} ví / ${trades.length} trade) < ${minRatio}`,
      data: {
        ratio,
        uniqueTraders: uniqueTraders.size,
        totalTrades: trades.length,
        minRatio,
      },
    };
  },
});
