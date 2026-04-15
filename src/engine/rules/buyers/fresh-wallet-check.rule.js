const settings = require('../../../config/settings');

/**
 * [DEPRECATED — đã được thay thế bởi new_wallet_accumulation]
 *
 * Rule này vẫn giữ lại để tương thích ngược nhưng DISABLED mặc định.
 * Nếu bật lên, nó sẽ dùng định nghĩa thống nhất isFreshNewWallet
 * (tuổi < 10h + < 5 tx) thay vì định nghĩa cũ (age < 1 ngày + funded 2h).
 *
 * Rule mới new_wallet_accumulation đã bao gồm logic này + kiểm tra % supply.
 */
module.exports = () => ({
  id: 'fresh_wallet_check',
  name: 'Fresh Wallet Detection (Legacy)',
  description: '[Legacy] Cảnh báo khi > N ví mua sớm là ví mới (< 10h tuổi, < 5 tx). Đã thay bằng new_wallet_accumulation.',
  enabled: false, // DISABLED — đã gộp vào new_wallet_accumulation
  type: 'ALERT',
  maxFreshCount: settings.rules.maxFreshCount,
  evaluate: (ctx) => {
    const { earlyBuyers } = ctx;
    if (!earlyBuyers || earlyBuyers.length < 2) {
      return { passed: true, reason: 'Chưa đủ buyer để đánh giá' };
    }

    // Dùng định nghĩa thống nhất isFreshNewWallet (< 10h tuổi + < 5 tx)
    const freshWallets = earlyBuyers.filter((buyer) => {
      if (buyer.isFreshNewWallet !== undefined) return buyer.isFreshNewWallet;
      // Fallback tương thích ngược
      const ageSeconds = buyer.walletAgeSeconds || (buyer.firstTxTimestamp ? (Date.now() / 1000 - buyer.firstTxTimestamp) : null);
      return (ageSeconds !== null && ageSeconds < 10 * 3600) && (buyer.txCount || 0) < 5;
    });

    const maxCount = ctx.rule?.maxFreshCount || settings.rules.maxFreshCount || 4;

    if (freshWallets.length > maxCount) {
      const nowSec = Date.now() / 1000;
      let detail = `⚠️ ${freshWallets.length}/${earlyBuyers.length} ví mua sớm là VÍ MỚI (> ${maxCount} ví)`;
      for (const w of freshWallets.slice(0, 5)) {
        const ageHours = w.walletAgeSeconds != null
          ? (w.walletAgeSeconds / 3600).toFixed(1)
          : (w.firstTxTimestamp ? ((nowSec - w.firstTxTimestamp) / 3600).toFixed(1) : '?');
        detail += `\n  → ${w.address.slice(0, 6)}...${w.address.slice(-4)} | ${w.txCount} txs | ${ageHours}h tuổi | ${w.balance?.toFixed(2) || '?'} SOL`;
      }
      return { passed: false, reason: detail };
    }

    return {
      passed: true,
      reason: `${freshWallets.length}/${earlyBuyers.length} ví mới (≤ ${maxCount} ví)`,
    };
  },
});
