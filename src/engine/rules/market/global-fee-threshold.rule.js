const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'global_fee_threshold',
  name: 'Global Fee Threshold',
  description: 'Kiểm tra global fee đạt ngưỡng > 0.3 SOL',
  enabled: true,
  type: 'REQUIRE',
  minGlobalFee: settings.rules.minGlobalFee,
  evaluate: (ctx) => {
    const { tokenData } = ctx;
    const threshold = ctx.rule?.minGlobalFee || settings.rules.minGlobalFee;
    const currentFee = tokenData.globalFee || (tokenData.volume ? tokenData.volume / 100 : 0);

    return {
      passed: currentFee >= threshold,
      reason: currentFee >= threshold
        ? `Global fee ${currentFee.toFixed(4)} SOL >= ${threshold}`
        : `Global fee ${currentFee.toFixed(4)} SOL < ${threshold}`,
    };
  },
});
