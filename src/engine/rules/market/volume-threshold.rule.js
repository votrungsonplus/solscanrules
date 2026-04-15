const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'volume_threshold',
  name: 'Volume Threshold',
  description: 'Volume phải > 30 SOL',
  enabled: true,
  type: 'REQUIRE',
  minVol: settings.rules.minVol,
  evaluate: (ctx) => {
    const { tokenData } = ctx;
    const actual = tokenData.volume || (tokenData.globalFee || 0) * 100;
    const min = ctx.rule?.minVol || settings.rules.minVol;
    const passed = actual >= min;

    return {
      passed,
      reason: passed
        ? `Vol hiện tại ${actual.toFixed(1)} SOL (Đạt mức > ${min} SOL)`
        : `Vol quá thấp: ${actual.toFixed(1)} SOL (Chưa đạt ${min} SOL)`,
    };
  },
});
