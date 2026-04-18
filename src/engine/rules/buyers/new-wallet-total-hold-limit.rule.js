const settings = require('../../../config/settings');

/**
 * Rule: New Wallet Total Hold Limit (final gate)
 *
 * Phòng tuyến cuối — sau khi tất cả rule khác đã PASS, kiểm tra tổng % token
 * mà các "ví mới" trong early buyers đang nắm.
 *
 *   - Lọc ví mới: isFreshNewWallet (tuổi < 10h VÀ < 5 tx).
 *     Có thêm bundle nếu bật includeBundleAsNew.
 *   - Tính tổng tokenAmount của các ví đó so với supply.
 *   - Nếu >= maxPercent → CHẶN.
 *
 * KHÔNG yêu cầu số lượng ví mới tối thiểu — 1 ví mới mua mạnh vẫn xét.
 * Reason luôn nói rõ "M ví mới (trong N early buyers) nắm X.XX% supply".
 */
module.exports = () => ({
  id: 'new_wallet_total_hold_limit',
  name: 'New Wallet Total Hold Limit',
  description: 'Cuối cùng: chặn nếu tổng % cung mà tất cả ví mới trong early buyers nắm >= ngưỡng',
  enabled: true,
  type: 'BLOCK',
  maxPercent: settings.rules.newWalletTotalHoldMaxPercent,
  includeBundleAsNew: true,

  evaluate: (ctx) => {
    const { earlyBuyers, earlyBuyerTrades, holderStats, bundleWallets } = ctx;

    if (!earlyBuyers || earlyBuyers.length === 0) {
      return { passed: true, reason: 'Chưa có early buyer để đánh giá' };
    }
    if (!holderStats || !holderStats.supply) {
      return { passed: true, reason: '⚠️ Thiếu dữ liệu tổng cung — bỏ qua rule này' };
    }

    const rule = ctx.rule || {};
    const maxPercent = rule.maxPercent ?? settings.rules.newWalletTotalHoldMaxPercent;
    const includeBundle = rule.includeBundleAsNew !== undefined ? rule.includeBundleAsNew : true;
    const totalSupply = holderStats.supply;
    const bundleSet = bundleWallets instanceof Set ? bundleWallets : new Set(bundleWallets || []);
    const totalBuyers = earlyBuyers.length;

    const freshWallets = earlyBuyers.filter((b) => {
      if (b.isFreshNewWallet === true) return true;
      if (includeBundle && bundleSet.has(b.address)) return true;
      return false;
    });

    if (freshWallets.length === 0) {
      return {
        passed: true,
        reason: `0 ví mới trong ${totalBuyers} early buyers — chấp nhận`,
        data: { newWalletCount: 0, totalEarlyBuyers: totalBuyers, percentHeld: 0, maxPercent },
      };
    }

    let totalTokenHeld = 0;
    const walletDetails = [];
    for (const wallet of freshWallets) {
      let tokenAmount = 0;
      if (earlyBuyerTrades) {
        const trade = earlyBuyerTrades.find((t) => t.trader === wallet.address);
        if (trade) tokenAmount = trade.tokenAmount || 0;
      }
      totalTokenHeld += tokenAmount;
      const isBundle = bundleSet.has(wallet.address);
      const ageHours = wallet.walletAgeSeconds != null
        ? (wallet.walletAgeSeconds / 3600).toFixed(1)
        : (wallet.firstTxTimestamp ? ((Date.now() / 1000 - wallet.firstTxTimestamp) / 3600).toFixed(1) : '?');
      walletDetails.push({
        address: wallet.address,
        isBundle,
        txCount: wallet.txCount || 0,
        ageHours,
        tokenAmount,
        percentOfSupply: (tokenAmount / totalSupply) * 100,
      });
    }

    const percentHeld = (totalTokenHeld / totalSupply) * 100;
    const passed = percentHeld < maxPercent;

    if (passed) {
      return {
        passed: true,
        reason: `${freshWallets.length} ví mới (trong ${totalBuyers} early buyers) nắm ${percentHeld.toFixed(2)}% cung (< ${maxPercent}%) — chấp nhận`,
        data: {
          newWalletCount: freshWallets.length,
          totalEarlyBuyers: totalBuyers,
          percentHeld,
          maxPercent,
          wallets: walletDetails,
        },
      };
    }

    let detail = `🚨 ${freshWallets.length} VÍ MỚI (trong ${totalBuyers} early buyers) nắm ${percentHeld.toFixed(2)}% cung (>= ${maxPercent}%)`;
    for (const w of walletDetails.slice(0, 7)) {
      const bundleTag = w.isBundle ? ' [BUNDLE]' : '';
      detail += `\n  → ${w.address.slice(0, 6)}...${w.address.slice(-4)} | ${w.txCount} txs | ${w.ageHours}h | ${w.percentOfSupply.toFixed(2)}% cung${bundleTag}`;
    }
    return {
      passed: false,
      reason: detail,
      data: {
        newWalletCount: freshWallets.length,
        totalEarlyBuyers: totalBuyers,
        percentHeld,
        maxPercent,
        wallets: walletDetails,
      },
    };
  },
});
