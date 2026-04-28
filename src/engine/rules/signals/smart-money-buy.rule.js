const smartMoney = require('../../../config/smart-money-wallets');

/**
 * Rule: Smart Money Buy
 *
 * INFO (positive signal) — phát hiện ví smart money mua sớm.
 * Smart money = ví có lịch sử PnL realized dương trên nhiều token (do user
 * cung cấp danh sách qua env/file).
 *
 * Type INFO không ảnh hưởng pass/fail — chỉ hiển thị thông tin để user biết
 * có "ví khôn" đã vào. Có thể đổi sang ALERT/REQUIRE qua env nếu user muốn
 * điều kiện cứng (ví dụ: chỉ mua khi có ít nhất 1 smart money buyer).
 */
module.exports = () => ({
  id: 'smart_money_buy',
  name: 'Smart Money Buy',
  description: 'Phát hiện ví smart money mua sớm (positive signal)',
  enabled: process.env.RULE_SMART_MONEY_ENABLED !== 'false',
  type: process.env.RULE_SMART_MONEY_TYPE || 'INFO',
  minSmartMoneyCount: parseInt(process.env.RULE_SMART_MONEY_MIN_COUNT || '1', 10),

  evaluate: (ctx) => {
    const buyers = Array.isArray(ctx.earlyBuyers) ? ctx.earlyBuyers : [];

    if (smartMoney.size() === 0) {
      return {
        passed: true,
        reason: 'Smart-money whitelist rỗng — bỏ qua (cấu hình SMART_MONEY_WALLETS hoặc data/smart-money.json)',
        data: { smartMoneyCount: 0, totalBuyers: buyers.length },
      };
    }

    const matches = buyers
      .filter(b => smartMoney.isSmartMoney(b.address))
      .map(b => ({ address: b.address, label: smartMoney.getLabel(b.address) }));

    const min = ctx.rule?.minSmartMoneyCount ?? 1;

    if (matches.length === 0) {
      return {
        passed: ctx.rule?.type === 'REQUIRE' ? false : true,
        reason: 'Không có ví smart money trong early buyers',
        data: { smartMoneyCount: 0, totalBuyers: buyers.length, minRequired: min },
      };
    }

    let detail = `🌟 ${matches.length} smart money mua sớm:`;
    for (const m of matches.slice(0, 5)) {
      detail += `\n  → ${m.address.slice(0, 6)}...${m.address.slice(-4)} (${m.label})`;
    }

    return {
      passed: matches.length >= min,
      reason: detail,
      data: {
        smartMoneyCount: matches.length,
        totalBuyers: buyers.length,
        minRequired: min,
        matches,
      },
    };
  },
});
