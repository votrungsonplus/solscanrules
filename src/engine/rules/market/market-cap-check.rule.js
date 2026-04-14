const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'market_cap_check',
  name: 'Market Cap Check',
  description: 'Vốn hoá thị trường phải đạt mức tối thiểu (SOL)',
  enabled: true,
  type: 'REQUIRE',
  minMarketCapSol: settings.rules.minMarketCapSol,
  retryable: true,
  evaluate: (ctx) => {
    const { tokenData } = ctx;
    const min = ctx.rule?.minMarketCapSol || settings.rules.minMarketCapSol || 10;
    const actual = tokenData.marketCapSol || 0;
    const passed = actual >= min;

    return {
      passed,
      retryable: !passed,
      reason: passed
        ? `MCap ${actual.toFixed(2)} SOL >= ${min} SOL ✓`
        : `MCap ${actual.toFixed(2)} SOL < ${min} SOL (chờ tăng...)`,
    };
  },
});
