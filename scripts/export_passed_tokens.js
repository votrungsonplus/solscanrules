const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

async function exportPassedTokens() {
  const dbPath = path.join(__dirname, '../data/trades.db');
  const reportsDir = path.join(__dirname, '../reports');
  
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Last 24 hours
  const since = Date.now() - 24 * 60 * 60 * 1000;
  
  console.log(`Searching for tokens passed since ${new Date(since).toLocaleString('vi-VN')}...`);

  const rows = db.prepare(`
    SELECT p.*, s.rule_result, s.holder_stats_json, s.dev_analysis_json
    FROM passed_tokens p
    LEFT JOIN token_scans s ON p.mint = s.mint
    WHERE p.timestamp > ?
    ORDER BY p.timestamp DESC
  `).all(since);

  if (rows.length === 0) {
    console.log('No tokens passed in the last 24 hours.');
    return;
  }

  console.log(`Found ${rows.length} tokens. Processing...`);

  const data = rows.map(row => {
    let clusterSignal = 'N/A';
    let top10Holders = 'N/A';
    let devHold = 'N/A';
    let ageAtPass = 'N/A';
    let volumeAtPass = 'N/A';
    let devRiskScore = 'N/A';
    let passSummary = 'Passed';

    try {
      if (row.rule_result) {
        const result = JSON.parse(row.rule_result);
        passSummary = result.summary || 'Passed';
        
        const clusterRule = result.results.find(r => r.ruleId === 'cluster_detection');
        if (clusterRule) clusterSignal = clusterRule.reason.replace(/\n/g, ' ');

        const holdersRule = result.results.find(r => r.ruleId === 'top10_holder_limit');
        if (holdersRule) top10Holders = holdersRule.reason;

        const devHoldRule = result.results.find(r => r.ruleId === 'dev_hold_limit');
        if (devHoldRule) devHold = devHoldRule.reason;

        const ageRule = result.results.find(r => r.ruleId === 'listing_age_limit');
        if (ageRule) ageAtPass = ageRule.reason;

        const volRule = result.results.find(r => r.ruleId === 'volume_threshold');
        if (volRule) volumeAtPass = volRule.reason;

        const riskRule = result.results.find(r => r.ruleId === 'dev_risk_check');
        if (riskRule) devRiskScore = riskRule.reason;
      }
    } catch (e) {
      console.error(`Error parsing rule_result for ${row.mint}:`, e.message);
    }

    const profit = row.launch_mcap_sol > 0 
      ? ((row.highest_mcap_sol / row.launch_mcap_sol - 1) * 100).toFixed(2) + '%'
      : '0.00%';

    return {
      'Thời gian': new Date(row.timestamp).toLocaleString('vi-VN'),
      'Ký hiệu': row.symbol || 'N/A',
      'Mint Address': row.mint,
      'Vốn hóa Pass (SOL)': row.launch_mcap_sol?.toFixed(2) || '0.00',
      'Vốn hóa ATH (SOL)': row.highest_mcap_sol?.toFixed(2) || '0.00',
      'Lợi nhuận (%)': profit,
      'Tín hiệu Cluster/Cabal': clusterSignal,
      'Top 10 Holders': top10Holders,
      'Dev Hold %': devHold,
      'Tuổi khi Pass': ageAtPass,
      'Volume khi Pass': volumeAtPass,
      'Dev Risk Score': devRiskScore,
      'Tổng kết': passSummary
    };
  });

  const fileName = `passed_tokens_24h_${new Date().toISOString().split('T')[0]}.xlsx`;
  const filePath = path.join(reportsDir, fileName);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);

  // Set column widths for better readability
  const wscols = [
    { wch: 20 }, // Thời gian
    { wch: 10 }, // Ký hiệu
    { wch: 45 }, // Mint Address
    { wch: 20 }, // Vốn hóa Pass
    { wch: 20 }, // Vốn hóa ATH
    { wch: 15 }, // Lợi nhuận
    { wch: 80 }, // Tín hiệu Cluster
    { wch: 50 }, // Top 10 Holders
    { wch: 30 }, // Dev Hold %
    { wch: 20 }, // Tuổi
    { wch: 20 }, // Volume
    { wch: 30 }, // Dev Risk
    { wch: 40 }  // Tổng kết
  ];
  ws['!cols'] = wscols;

  XLSX.utils.book_append_sheet(wb, ws, 'Passed Tokens 24H');
  XLSX.writeFile(wb, filePath);

  console.log(`Report generated successfully: ${filePath}`);
}

exportPassedTokens().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
