module.exports = () => ({
  id: 'same_buy_amount',
  name: 'Same Buy Amount Detection',
  description: 'Phát hiện các ví mua cùng lượng SOL giống nhau (cabal signal)',
  enabled: true,
  type: 'ALERT',
  tolerancePercent: 10,
  evaluate: (ctx) => {
    const { earlyBuyerTrades, clusterAnalysis } = ctx;
    if (earlyBuyerTrades.length < 2) {
      return { passed: true, reason: 'Chưa đủ trades để so sánh' };
    }

    const amounts = earlyBuyerTrades.map((t) => t.solAmount);
    const tolerance = (ctx.rule?.tolerancePercent || 10) / 100;

    const groups = [];
    for (let i = 0; i < amounts.length; i++) {
      const amount = amounts[i];
      let found = false;
      for (const group of groups) {
        if (Math.abs(group.avg - amount) / Math.max(group.avg, 0.001) <= tolerance) {
          group.count++;
          group.avg = (group.avg * (group.count - 1) + amount) / group.count;
          group.amounts.push(amount);
          group.wallets.push(earlyBuyerTrades[i].trader);
          found = true;
          break;
        }
      }
      if (!found) {
        groups.push({
          avg: amount,
          count: 1,
          amounts: [amount],
          wallets: [earlyBuyerTrades[i].trader],
        });
      }
    }

    const largestGroup = groups.reduce((max, g) => (g.count > max.count ? g : max), { count: 0 });
    const hasMatchingAmounts = largestGroup.count >= 3;

    if (hasMatchingAmounts) {
      const walletsInCluster = largestGroup.wallets.filter((w) =>
        clusterAnalysis?.wallets?.some((cw) => cw.address === w)
      ).length;

      let detail = `⚠️ Tín hiệu Cabal: ${largestGroup.count} ví mua cùng lượng ~${largestGroup.avg.toFixed(4)} SOL`;
      if (walletsInCluster > 0) detail += ` (${walletsInCluster} ví từ cùng nguồn tiền)`;

      return {
        passed: false,
        reason: detail,
      };
    }
    return { passed: true, reason: 'Không phát hiện nhóm ví mua cùng số tiền' };
  },
});
