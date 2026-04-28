/**
 * Rule: Transfer Fee Check (Token-2022)
 *
 * BLOCK nếu token là Token-2022 và có transferFeeConfig với basisPoints > ngưỡng.
 * Mặc định ngưỡng = 0 (tức bất kỳ fee nào cũng block) — đây là dạng honeypot tinh vi:
 * mỗi giao dịch user mất X% supply, dev gom hết qua withdrawWithheldAuthority.
 *
 * Token PumpFun thường là SPL Token legacy → rule này chỉ kích hoạt khi token-2022.
 */
module.exports = () => ({
  id: 'transfer_fee_check',
  name: 'Transfer Fee Check',
  description: 'Chặn token Token-2022 có transferFee > ngưỡng',
  enabled: process.env.RULE_TRANSFER_FEE_ENABLED !== 'false',
  type: 'BLOCK',
  // basisPoints = 1/100 of 1%. 100bp = 1%.
  maxBasisPoints: parseInt(process.env.RULE_TRANSFER_FEE_MAX_BP || '0', 10),

  evaluate: (ctx) => {
    const mintInfo = ctx.holderStats?.mintInfo;
    if (!mintInfo) return { passed: true, reason: 'Không lấy được mint info — bỏ qua check' };

    if (!mintInfo.isToken2022) {
      return { passed: true, reason: 'SPL Token legacy — không có transferFee extension' };
    }

    const max = ctx.rule?.maxBasisPoints ?? 0;
    const bp = mintInfo.transferFeeBasisPoints || 0;
    const passed = bp <= max;
    const pct = (bp / 100).toFixed(2);

    return {
      passed,
      reason: passed
        ? `Token-2022 transferFee ${pct}% (≤ ${(max / 100).toFixed(2)}%) ✓`
        : `🚫 Token-2022 có transferFee ${pct}% — honeypot risk (mỗi giao dịch mất ${pct}% supply)`,
      data: { transferFeeBasisPoints: bp, maxBasisPoints: max, isToken2022: true },
    };
  },
});
