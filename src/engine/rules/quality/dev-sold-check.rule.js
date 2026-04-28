/**
 * Rule: Dev Sold Check
 *
 * BLOCK nếu deployer đã có tx sell trên token này trong window kể từ khi tạo.
 * Tracking ở orchestrator: khi `_onTrade` thấy `tradeData.trader === tokenData.deployer`
 * và `txType === 'sell'` → set `tokenData.devSold = true` + `devSoldAt = ts`.
 *
 * Đây là tín hiệu kết liễu: dev xả là tín hiệu sớm nhất của rug. KHÔNG retryable.
 */
module.exports = () => ({
  id: 'dev_sold_check',
  name: 'Dev Sold Check',
  description: 'Chặn ngay nếu deployer đã sell token trong window từ lúc tạo',
  enabled: process.env.RULE_DEV_SOLD_ENABLED !== 'false',
  type: 'BLOCK',
  // Window từ tạo token để xét. Mặc định 30 phút — sau đó có thể bỏ qua (token đã trưởng thành).
  // Đặt 0 = mọi lúc.
  windowMinutes: parseInt(process.env.RULE_DEV_SOLD_WINDOW_MIN || '30', 10),
  retryable: false,

  evaluate: (ctx) => {
    const td = ctx.tokenData || {};
    if (!td.devSold) {
      return { passed: true, reason: 'Deployer chưa xả token' };
    }

    const window = ctx.rule?.windowMinutes ?? 30;
    if (window > 0 && td.devSoldAt && td.timestamp) {
      const minutesSinceCreate = (td.devSoldAt - td.timestamp) / 60000;
      if (minutesSinceCreate > window) {
        return {
          passed: true,
          reason: `Deployer xả sau ${minutesSinceCreate.toFixed(1)} phút (> window ${window}m, bỏ qua)`,
        };
      }
    }

    const elapsed = td.devSoldAt && td.timestamp
      ? `${((td.devSoldAt - td.timestamp) / 60000).toFixed(1)}m sau tạo`
      : 'không rõ thời điểm';
    return {
      passed: false,
      reason: `🚫 Deployer ĐÃ XẢ TOKEN (${elapsed}) — rug signal`,
      data: { devSoldAt: td.devSoldAt, devSoldAmount: td.devSoldAmount || null },
    };
  },
});
