const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'token_score_check',
  name: 'Token Score Check',
  description: 'Kiểm tra điểm token metadata/quality',
  enabled: false,
  type: 'REQUIRE',
  minScore: settings.rules.minScore,
  evaluate: (ctx) => {
    const { tokenScore } = ctx;
    if (!tokenScore) return { passed: true, reason: 'No token score data' };

    const minScore = ctx.rule?.minScore || settings.rules.minScore;
    return {
      passed: tokenScore.totalScore >= minScore,
      reason: `Token score: ${tokenScore.totalScore}/100 (${tokenScore.verdict})`,
    };
  },
});
