const settings = require('../../../config/settings');

/**
 * Rule: Jito Real Bundle Block
 *
 * Chặn nếu các ví trong Jito Bundle THẬT (có tx tip tới Jito tip account)
 * đang nắm > maxPercent supply.
 *
 * Khác với `bundle_limit` (đo same-slot ≥ 4 ví — có thể là sniper bot ngẫu nhiên),
 * rule này chỉ kích hoạt khi đã verify có tip Jito → cao xác suất là searcher
 * submit bundle thật → nhiều khả năng là dev/insider rửa qua Jito.
 *
 * Threshold mặc định 5% — siết hơn bundle_limit (10%) vì Jito bundle thật
 * có ý đồ cao hơn rất nhiều so với same-slot ngẫu nhiên.
 */
module.exports = () => ({
  id: 'jito_real_bundle_block',
  name: 'Jito Real Bundle Block',
  description: 'Chặn nếu Jito Bundle thật (có tip) nắm quá nhiều supply',
  enabled: true,
  type: 'BLOCK',
  maxPercent: parseFloat(process.env.RULE_JITO_BUNDLE_MAX_PCT || '5'),

  evaluate: (ctx) => {
    const { holderStats, jitoBundleWallets } = ctx;
    if (!holderStats || holderStats.dataInvalid) {
      return { passed: true, reason: 'Không đủ dữ liệu holder để đánh giá Jito Bundle' };
    }

    const max = ctx.rule?.maxPercent ?? 5;
    const actual = holderStats.jitoBundleHoldPercent || 0;
    const walletCount = jitoBundleWallets?.size || 0;

    if (walletCount === 0) {
      return {
        passed: true,
        reason: 'Không phát hiện Jito Bundle thật (không có tx tip Jito)',
        data: { jitoBundleHoldPercent: 0, walletCount: 0, maxPercent: max },
      };
    }

    const passed = actual < max;
    return {
      passed,
      reason: passed
        ? `Jito Bundle: ${walletCount} ví nắm ${actual.toFixed(2)}% supply (< ${max}%) ✓`
        : `🚫 Jito Bundle thật: ${walletCount} ví nắm ${actual.toFixed(2)}% supply (>= ${max}%) — searcher đã rửa qua Jito`,
      data: { jitoBundleHoldPercent: actual, walletCount, maxPercent: max },
    };
  },
});
