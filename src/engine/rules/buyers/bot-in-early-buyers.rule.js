/**
 * Rule: Bot / MEV in Early Buyers
 *
 * ALERT (không BLOCK) nếu trong early buyers có ví bị flag là MEV/bot.
 * Tín hiệu detect: roundtrip nhanh (buy + sell < 5s), known MEV signer, hoặc
 * heuristic high-frequency tx (≥ 100 tx/h). Các ví này KHÔNG phải insider/retail
 * thật → nếu chiếm tỉ lệ cao trong tập early buyer, các metric concentration sẽ
 * bị nhiễu (ví dụ whale_buy_concentration đếm cả MEV roundtrip).
 *
 * Có thể nâng lên BLOCK qua env nếu user muốn siết.
 */
module.exports = () => ({
  id: 'bot_in_early_buyers',
  name: 'Bot / MEV in Early Buyers',
  description: 'Cảnh báo nếu có ví MEV/bot trong tập early buyers',
  enabled: process.env.RULE_BOT_DETECT_ENABLED !== 'false',
  type: process.env.RULE_BOT_DETECT_TYPE || 'ALERT', // ALERT | BLOCK
  maxBotCount: parseInt(process.env.RULE_BOT_DETECT_MAX_COUNT || '2', 10),

  evaluate: (ctx) => {
    const { mevWallets, mevReasons, earlyBuyers } = ctx;
    const buyers = Array.isArray(earlyBuyers) ? earlyBuyers : [];
    const max = ctx.rule?.maxBotCount ?? 2;

    if (!mevWallets || mevWallets.size === 0) {
      return {
        passed: true,
        reason: '0 ví MEV/bot trong early buyers',
        data: { mevCount: 0, totalBuyers: buyers.length, maxBotCount: max },
      };
    }

    // Chỉ tính ví MEV nằm trong early buyers (không tính ví roundtrip ngoài)
    const inBuyers = buyers.filter(b => mevWallets.has(b.address)).map(b => b.address);
    if (inBuyers.length === 0) {
      return {
        passed: true,
        reason: `${mevWallets.size} ví MEV phát hiện ngoài early buyers (không ảnh hưởng)`,
        data: { mevCount: 0, totalBuyers: buyers.length, maxBotCount: max },
      };
    }

    const passed = inBuyers.length <= max;
    let detail = `${inBuyers.length}/${buyers.length} early buyer(s) là MEV/bot`;
    for (const addr of inBuyers.slice(0, 5)) {
      const reasons = mevReasons?.get?.(addr) || [];
      detail += `\n  → ${addr.slice(0, 6)}...${addr.slice(-4)} | ${reasons.join(', ') || 'unknown'}`;
    }

    return {
      passed,
      reason: passed
        ? `${detail} (≤ ${max}, chấp nhận)`
        : `🚫 ${detail} (> ${max} — early buyers bị nhiễm MEV)`,
      data: {
        mevCount: inBuyers.length,
        totalBuyers: buyers.length,
        maxBotCount: max,
        addresses: inBuyers,
      },
    };
  },
});
