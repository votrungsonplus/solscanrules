module.exports = () => ({
  id: 'white_wallet_from_cex',
  name: 'White Wallet From CEX',
  description: 'Ví trắng nhận tiền từ sàn CEX (organic buyer signal)',
  enabled: true,
  type: 'INFO',
  evaluate: (ctx) => {
    const { earlyBuyers } = ctx;
    const cexFunded = earlyBuyers.filter((buyer) =>
      buyer.isWhiteWallet && buyer.sourceOfFunds?.hasCEXFunding
    );

    return {
      passed: true,
      reason: `${cexFunded.length} early buyer(s) funded from CEX`,
      data: { cexFundedCount: cexFunded.length },
    };
  },
});
