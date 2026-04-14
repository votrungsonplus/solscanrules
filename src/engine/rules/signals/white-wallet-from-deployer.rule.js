module.exports = () => ({
  id: 'white_wallet_from_deployer',
  name: 'White Wallet From Deployer',
  description: 'Phát hiện ví trắng nhận tiền từ deployer (insider signal)',
  enabled: true,
  type: 'ALERT',
  evaluate: (ctx) => {
    const { earlyBuyers, tokenData } = ctx;
    const deployer = tokenData.deployer;

    const whiteWalletsFromDev = earlyBuyers.filter((buyer) =>
      buyer.isWhiteWallet && buyer.fundingWallets.includes(deployer)
    );

    if (whiteWalletsFromDev.length > 0) {
      let detail = `${whiteWalletsFromDev.length} VÍ TRẮNG nhận tiền từ deployer`;
      for (const w of whiteWalletsFromDev) {
        detail += `\n  → ${w.address.slice(0, 6)}...${w.address.slice(-4)} [VÍ TRẮNG] | ${w.txCount} txs | ${w.walletAgeDays} ngày`;
      }
      return { passed: false, reason: detail };
    }
    return { passed: true, reason: 'Không có VÍ TRẮNG từ deployer' };
  },
});
