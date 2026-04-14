const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'bonding_curve_progress',
  name: 'Bonding Curve Progress',
  description: 'Kiểm tra % tiến trình bonding curve',
  enabled: false,
  type: 'INFO',
  maxProgressPercent: settings.rules.maxProgressPercent,
  evaluate: (ctx) => {
    const { bondingCurveProgress } = ctx;
    if (bondingCurveProgress === undefined) return { passed: true, reason: 'No bonding curve data' };

    const maxProgress = ctx.rule?.maxProgressPercent || settings.rules.maxProgressPercent || 80;
    return {
      passed: bondingCurveProgress < maxProgress,
      reason: `Bonding curve: ${bondingCurveProgress.toFixed(1)}% (max: ${maxProgress}%)`,
    };
  },
});
