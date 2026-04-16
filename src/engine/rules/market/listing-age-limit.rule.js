const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'listing_age_limit',
  name: 'Listing Age Check',
  description: 'Token list < 5 phút',
  enabled: true,
  type: 'REQUIRE',
  maxMinutes: settings.rules.maxMinutes,
  retryable: true,
  evaluate: (ctx) => {
    const { tokenData } = ctx;
    const ageMinutes = (Date.now() - tokenData.timestamp) / 60000;
    const max = ctx.rule?.maxMinutes || settings.rules.maxMinutes;

    return {
      passed: ageMinutes < max,
      reason: `Age: ${ageMinutes.toFixed(1)}m (max: ${max}m)`,
    };
  },
});
