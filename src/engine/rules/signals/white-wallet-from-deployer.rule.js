module.exports = () => ({
  id: 'white_wallet_from_deployer',
  name: 'Fresh Wallet From Deployer',
  description: 'Phát hiện ví mới (< 10h, < 5 tx) nhận tiền từ deployer (insider signal)',
  enabled: true,
  type: 'ALERT',
  evaluate: (ctx) => {
    const { earlyBuyers, tokenData } = ctx;
    const deployer = tokenData.deployer;

    const freshWalletsFromDev = earlyBuyers.filter((buyer) =>
      buyer.isFreshNewWallet && buyer.fundingWallets.includes(deployer)
    );

    if (freshWalletsFromDev.length > 0) {
      let detail = `${freshWalletsFromDev.length} VÍ MỚI nhận tiền từ deployer`;
      for (const w of freshWalletsFromDev) {
        detail += `\n  → ${w.address.slice(0, 6)}...${w.address.slice(-4)} [VÍ MỚI] | ${w.txCount} txs | ${w.walletAgeDays} ngày`;
      }
      return { passed: false, reason: detail };
    }
    return { passed: true, reason: 'Không có VÍ MỚI từ deployer' };
  },
});
