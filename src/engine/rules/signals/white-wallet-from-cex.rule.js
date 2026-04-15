module.exports = () => ({
  id: 'white_wallet_from_cex',
  name: 'Fresh Wallet From CEX',
  description: 'Ví mới (< 10h, < 5 tx) nhận tiền từ sàn CEX (organic buyer signal)',
  enabled: true,
  type: 'INFO',
  evaluate: (ctx) => {
    const { earlyBuyers } = ctx;
    const cexFunded = earlyBuyers.filter((buyer) =>
      buyer.isFreshNewWallet && buyer.sourceOfFunds?.hasCEXFunding
    );

    return {
      passed: true,
      reason: `${cexFunded.length} early buyer(s) là ví mới funded từ CEX`,
      data: { cexFundedCount: cexFunded.length },
    };
  },
});
