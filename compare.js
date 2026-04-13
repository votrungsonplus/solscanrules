const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data/trades.db');

db.all(`
  SELECT s.mint, s.token_symbol, p.pnl_percent, p.held_seconds,
         t.dev_risk_score, t.cluster_detected, t.holder_stats_json, t.dev_analysis_json
  FROM simulator_positions p
  JOIN token_scans t ON p.mint = t.mint
  WHERE p.status = 'CLOSED' AND t.action_taken = 'ELIGIBLE'
`, (err, rows) => {
  if (err) throw err;
  
  const rugs = [];
  const winners = [];
  
  for (const r of rows) {
    if (r.pnl_percent < -70 && r.held_seconds < 60) rugs.push(r);
    else if (r.pnl_percent >= 50) winners.push(r);
  }
  
  function analyzeGroup(group) {
    let avgRisk = 0, devRugRatio = 0, bundleAvg = 0, top10Avg = 0, devHoldAvg = 0, clusterPct = 0;
    let validHolders = 0;
    
    for (const r of group) {
      avgRisk += r.dev_risk_score;
      if (r.cluster_detected) clusterPct++;
      
      try {
         const devInfo = JSON.parse(r.dev_analysis_json);
         if (devInfo) devRugRatio += devInfo.rugPullRatio || 0;
      } catch(e){}
      
      try {
         const holders = JSON.parse(r.holder_stats_json);
         if (holders && !holders.dataInvalid) {
           bundleAvg += holders.bundleHoldPercent || 0;
           top10Avg += holders.top10Percent || 0;
           devHoldAvg += holders.devHoldPercent || 0;
           validHolders++;
         }
      } catch(e){}
    }
    
    return {
      count: group.length,
      avgRisk: (avgRisk / group.length).toFixed(1),
      avgRugRatio: (devRugRatio / group.length).toFixed(2),
      clusterDetectedPct: ((clusterPct / group.length) * 100).toFixed(1) + '%',
      avgBundle: validHolders ? (bundleAvg / validHolders).toFixed(1) + '%' : 'N/A',
      avgTop10: validHolders ? (top10Avg / validHolders).toFixed(1) + '%' : 'N/A',
      avgDevHold: validHolders ? (devHoldAvg / validHolders).toFixed(1) + '%' : 'N/A',
    };
  }
  
  console.log("=== RUG TOKENS (-70% in <60s) ===");
  console.table(analyzeGroup(rugs));
  
  console.log("\n=== WINNER TOKENS (> +50%) ===");
  console.table(analyzeGroup(winners));
});
