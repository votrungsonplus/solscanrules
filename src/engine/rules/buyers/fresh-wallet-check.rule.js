const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'fresh_wallet_check',
  name: 'Fresh Wallet Detection',
  description: 'Cảnh báo khi > 4 ví mua sớm là ví mới (0 SOL cho đến ~2h trước)',
  enabled: true,
  type: 'ALERT',
  maxFreshCount: settings.rules.maxFreshCount,
  evaluate: (ctx) => {
    const { earlyBuyers } = ctx;
    if (!earlyBuyers || earlyBuyers.length < 2) {
      return { passed: true, reason: 'Chưa đủ buyer để đánh giá' };
    }

    const nowSec = Date.now() / 1000;
    const twoHoursAgo = nowSec - (2 * 3600);

    const freshWallets = earlyBuyers.filter((buyer) => {
      const isYoung = buyer.walletAgeDays < 1;
      const firstFundedRecently = buyer.firstTxTimestamp && buyer.firstTxTimestamp > twoHoursAgo;
      return isYoung && firstFundedRecently;
    });

    const maxCount = ctx.rule?.maxFreshCount || settings.rules.maxFreshCount || 4;

    if (freshWallets.length > maxCount) {
      let detail = `⚠️ ${freshWallets.length}/${earlyBuyers.length} ví mua sớm là VÍ MỚI TOANH (> ${maxCount} ví)`;
      for (const w of freshWallets.slice(0, 5)) {
        const ageHours = w.firstTxTimestamp ? ((nowSec - w.firstTxTimestamp) / 3600).toFixed(1) : '?';
        detail += `\n  → ${w.address.slice(0, 6)}...${w.address.slice(-4)} | ${w.txCount} txs | ${ageHours}h tuổi | ${w.balance?.toFixed(2) || '?'} SOL`;
      }
      return { passed: false, reason: detail };
    }

    return {
      passed: true,
      reason: `${freshWallets.length}/${earlyBuyers.length} ví mới toanh (≤ ${maxCount} ví)`,
    };
  },
});
