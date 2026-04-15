const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'dev_risk_check',
  name: 'Dev Risk Check',
  description: 'Kiểm tra độ rủi ro của deployer dựa trên lịch sử',
  enabled: true,
  type: 'ALERT',
  maxRiskScore: settings.rules.maxRiskScore,
  evaluate: (ctx) => {
    const { devAnalysis } = ctx;
    if (!devAnalysis) return { passed: true, reason: 'No dev analysis data' };

    const maxScore = ctx.rule?.maxRiskScore || settings.rules.maxRiskScore;
    return {
      passed: devAnalysis.riskScore < maxScore,
      reason: devAnalysis.riskScore >= maxScore
        ? `Dev risk score ${devAnalysis.riskScore}/100 exceeds max ${maxScore} (${devAnalysis.riskLevel})`
        : `Dev risk score: ${devAnalysis.riskScore}/100 (${devAnalysis.riskLevel})`,
    };
  },
});
