const settings = require('../../../config/settings');

/**
 * Rule: New Wallet Accumulation Detection
 *
 * Phát hiện hành vi tích trữ bằng ví mới:
 * - Nếu trong X ví mua đầu tiên ĐỀU là "ví mới" (tuổi < 10h, < 5 tx)
 * - VÀ tổng token mua + nắm giữ tại thời điểm đánh giá < Y% tổng cung
 *
 * Bao gồm cả ví bundle và ví bot sniper (có toggle bật/tắt).
 *
 * Định nghĩa thống nhất "ví mới" (isFreshNewWallet):
 *   - Tuổi ví < 10 tiếng
 *   - Số giao dịch < 5
 */
module.exports = () => ({
  id: 'new_wallet_accumulation',
  name: 'New Wallet Accumulation',
  description: 'Chặn nếu X ví mua đầu tiên đều là ví mới và tổng nắm giữ > Y% tổng cung',
  enabled: true,
  type: 'BLOCK',
  // Số ví mua đầu tiên cần kiểm tra (X) — người dùng tuỳ chỉnh
  checkFirstXBuyers: settings.rules.accumulationCheckFirstX || 5,
  // Ngưỡng % tổng cung tối đa (Y) — người dùng tuỳ chỉnh
  maxAccumulationPercent: settings.rules.accumulationMaxPercent || 15,
  // Toggle: có tính ví bundle/bot vào danh sách ví mới không (mặc định: CÓ)
  includeBundleAsNew: true,

  evaluate: (ctx) => {
    const { earlyBuyers, earlyBuyerTrades, holderStats, bundleWallets } = ctx;

    if (!earlyBuyers || earlyBuyers.length === 0) {
      return { passed: true, reason: 'Chưa có early buyer để đánh giá' };
    }
    if (!holderStats || !holderStats.supply) {
      return { passed: false, reason: '⚠️ Thiếu dữ liệu tổng cung' };
    }

    const rule = ctx.rule || {};
    const X = rule.checkFirstXBuyers || settings.rules.accumulationCheckFirstX;
    const Y = rule.maxAccumulationPercent || settings.rules.accumulationMaxPercent;
    const includeBundle = rule.includeBundleAsNew !== undefined ? rule.includeBundleAsNew : true;
    const totalSupply = holderStats.supply;

    // Lấy X ví mua đầu tiên
    const firstXBuyers = earlyBuyers.slice(0, X);

    if (firstXBuyers.length < X) {
      return {
        passed: true,
        reason: `Chỉ có ${firstXBuyers.length}/${X} ví — chưa đủ để đánh giá`,
      };
    }

    // Tập hợp bundle wallets (Set) từ context
    const bundleSet = bundleWallets instanceof Set ? bundleWallets : new Set(bundleWallets || []);

    // Xác định từng ví có phải "ví mới" không
    const walletDetails = firstXBuyers.map((buyer) => {
      const isBundle = bundleSet.has(buyer.address);

      // isFreshNewWallet: định nghĩa duy nhất — tuổi < 10h VÀ < 5 tx
      let isNew = buyer.isFreshNewWallet === true;

      // Nếu là ví bundle và toggle bật → coi là ví mới
      if (isBundle && includeBundle) {
        isNew = true;
      }

      // Lấy token amount từ earlyBuyerTrades
      let tokenAmount = 0;
      if (earlyBuyerTrades) {
        const trade = earlyBuyerTrades.find(t => t.trader === buyer.address);
        if (trade) tokenAmount = trade.tokenAmount || 0;
      }

      const ageHours = buyer.walletAgeSeconds != null
        ? (buyer.walletAgeSeconds / 3600).toFixed(1)
        : (buyer.firstTxTimestamp ? ((Date.now() / 1000 - buyer.firstTxTimestamp) / 3600).toFixed(1) : '?');

      return {
        address: buyer.address,
        isNew,
        isBundle,
        txCount: buyer.txCount || 0,
        ageHours,
        tokenAmount,
      };
    });

    const newWallets = walletDetails.filter(w => w.isNew);
    const allAreNew = newWallets.length === firstXBuyers.length;

    // Nếu không phải tất cả đều là ví mới → pass
    if (!allAreNew) {
      const oldCount = firstXBuyers.length - newWallets.length;
      return {
        passed: true,
        reason: `${newWallets.length}/${X} ví đầu là ví mới (${oldCount} ví cũ) — không phải tích trữ toàn bộ`,
        data: { newWalletCount: newWallets.length, totalChecked: X },
      };
    }

    // Tất cả X ví đầu đều là ví mới → kiểm tra % supply
    const totalTokensHeld = walletDetails.reduce((sum, w) => sum + w.tokenAmount, 0);
    const percentHeld = (totalTokensHeld / totalSupply) * 100;

    if (percentHeld >= Y) {
      // CHẶN: Tất cả ví mới + nắm quá nhiều supply
      let detail = `🚨 TẤT CẢ ${X} ví mua đầu đều là VÍ MỚI và nắm ${percentHeld.toFixed(2)}% cung (> ${Y}%)`;
      for (const w of walletDetails.slice(0, 7)) {
        const bundleTag = w.isBundle ? ' [BUNDLE]' : '';
        detail += `\n  → ${w.address.slice(0, 6)}...${w.address.slice(-4)} | ${w.txCount} txs | ${w.ageHours}h tuổi | ${((w.tokenAmount / totalSupply) * 100).toFixed(2)}% cung${bundleTag}`;
      }
      return {
        passed: false,
        reason: detail,
        data: {
          newWalletCount: newWallets.length,
          totalChecked: X,
          percentHeld,
          maxPercent: Y,
          wallets: walletDetails,
        },
      };
    }

    // Tất cả ví mới nhưng nắm ít → pass (cảnh báo nhẹ)
    return {
      passed: true,
      reason: `${X}/${X} ví đầu là ví mới nhưng chỉ nắm ${percentHeld.toFixed(2)}% cung (< ${Y}%) — chấp nhận`,
      data: { newWalletCount: newWallets.length, totalChecked: X, percentHeld, maxPercent: Y },
    };
  },
});
