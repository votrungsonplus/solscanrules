const settings = require('../../../config/settings');

module.exports = () => ({
  id: 'cluster_detection',
  name: 'Cluster Detection',
  description: 'Phát hiện nhóm ví liên kết (Tín hiệu Winner x5+)',
  enabled: true,
  type: 'REQUIRE',
  minSharedFunders: settings.rules.minSharedFunders,
  evaluate: (ctx) => {
    const { clusterAnalysis } = ctx;
    if (!clusterAnalysis) return { passed: false, reason: 'Không có dữ liệu cluster' };

    if (!clusterAnalysis.isLikelyCluster) {
      return { passed: false, reason: 'Không phát hiện nhóm ví cùng nguồn (Cần tín hiệu cabal backing)' };
    }

    const minFunders = ctx.rule?.minSharedFunders || settings.rules.minSharedFunders;
    const actualFunders = clusterAnalysis.sharedFunders.length;
    const isStrong = actualFunders >= minFunders;

    let detail = `Insider signal: ${actualFunders} ví mẹ chung (Chia tiền)`;
    for (const f of clusterAnalysis.sharedFunders.slice(0, 3)) {
      detail += `\n  → ${f.address.slice(0, 6)}...${f.address.slice(-4)} | ${f.sharedBy} ví con`;
    }

    return {
      passed: isStrong,
      reason: isStrong ? `✅ Tín hiệu Cabal mạnh: ${detail}` : `❌ Tín hiệu Cabal yếu: ${detail} (Cần ≥ ${minFunders} ví mẹ để an toàn)`,
    };
  },
});
