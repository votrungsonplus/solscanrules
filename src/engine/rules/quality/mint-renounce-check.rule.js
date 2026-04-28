/**
 * Rule: Mint / Freeze Authority Renounce Check
 *
 * BLOCK nếu mint authority HOẶC freeze authority chưa được renounce (tức != null).
 *  - mintAuthority != null → dev có thể mint thêm supply, dilute holders bất kỳ lúc nào
 *  - freezeAuthority != null → dev có thể freeze ATA của user, biến token thành honeypot
 *
 * PumpFun standard token thường renounce cả 2 ngay khi tạo (mint authority chuyển
 * cho bonding-curve PDA, freeze authority null). Token KHÔNG match pattern này
 * cực kỳ đáng ngờ.
 *
 * Cho phép tắt qua env nếu user muốn cover edge case (vd. token vesting hợp lệ).
 */
module.exports = () => ({
  id: 'mint_renounce_check',
  name: 'Mint / Freeze Authority Renounce',
  description: 'Chặn nếu mint authority hoặc freeze authority chưa renounce',
  enabled: process.env.RULE_MINT_RENOUNCE_ENABLED !== 'false',
  type: 'BLOCK',

  evaluate: (ctx) => {
    const mintInfo = ctx.holderStats?.mintInfo;
    if (!mintInfo) {
      // Không lấy được mint info (RPC fail) — không thể verify, để pass tránh false-block
      return { passed: true, reason: 'Không lấy được mint info — bỏ qua check' };
    }

    const { mintAuthority, freezeAuthority } = mintInfo;
    const failures = [];
    if (mintAuthority) failures.push(`mintAuthority=${mintAuthority.slice(0, 6)}...`);
    if (freezeAuthority) failures.push(`freezeAuthority=${freezeAuthority.slice(0, 6)}...`);

    if (failures.length === 0) {
      return {
        passed: true,
        reason: '✓ Mint + Freeze authority đã renounce (an toàn)',
        data: { mintAuthority: null, freezeAuthority: null },
      };
    }

    return {
      passed: false,
      reason: `🚫 Authority chưa renounce: ${failures.join(', ')} — risk honeypot/dilute`,
      data: { mintAuthority, freezeAuthority },
    };
  },
});
