#!/usr/bin/env node
/**
 * Migration: Apply Data-Optimal Rule Config
 *
 * Cập nhật DB bot_settings với cấu hình tối ưu dựa trên phân tích 2,205 pass token.
 * CHẠY SAU KHI ĐÃ DỪNG BOT để tránh ghi đè đồng thời.
 *
 *   $ node scripts/apply-optimal-config.js [--dry-run]
 *
 * Sẽ:
 *  - Bật lại sybil_protection (đã bị tắt)
 *  - Tăng floor MCap 80→100, thêm ceiling 250
 *  - Siết top10 60→50, dev 60→30, bundle 20→10
 *  - Đăng ký 2 rule mới: launch_mcap_ceiling, whale_buy_concentration
 *  - Bật anti-top-buy guard 5s/8%
 *
 * KHÔNG xoá bất kỳ dữ liệu nào (passed_tokens, trades, scans).
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DRY_RUN = process.argv.includes('--dry-run');

function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const candidates = [
    path.join(__dirname, '../data/trades.db'), // worktree-local
    path.resolve(__dirname, '../../../../data/trades.db'), // git worktree → repo gốc (4 cấp)
    path.resolve(__dirname, '../../../data/trades.db'),
    '/Users/votrungson/DATA CAPTAIN/SCAN SOL BOT/solscanrules/data/trades.db',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]; // tạo mới nếu chưa có
}

const DB_PATH = resolveDbPath();

// === Bộ thay đổi áp dụng ===
const SETTINGS_UPDATES = {
  // Profile
  activeRuleProfile: 'strict_current',

  // Rule states (true/false)
  rule_sybil_protection: 'true',
  rule_same_buy_amount: 'true', // đã true rồi nhưng giữ idempotent
  rule_launch_mcap_ceiling: 'true',
  rule_whale_buy_concentration: 'true',
  rule_market_cap_check: 'true',
  rule_volume_threshold: 'true',
  rule_global_fee_threshold: 'true',
  rule_top10_holder_limit: 'true',
  rule_dev_hold_limit: 'true',
  rule_bundle_limit: 'true',
  rule_listing_age_limit: 'true',
  rule_dev_risk_check: 'true',
  rule_early_buyer_count_check: 'true',
  rule_first_7_buyers_hold_limit: 'true',
  rule_new_wallet_accumulation: 'true',
  rule_new_wallet_total_hold_limit: 'true',
  rule_white_wallet_from_deployer: 'true',
  rule_white_wallet_from_cex: 'true',
  // Giữ tắt
  rule_cluster_detection: 'false',
  rule_token_score_check: 'false',
  rule_bonding_curve_progress: 'false',

  // Rule numeric params
  rule_market_cap_check_minMarketCapSol: '100',
  rule_launch_mcap_ceiling_maxMarketCapSol: '250',
  rule_volume_threshold_minVol: '90',
  rule_global_fee_threshold_minGlobalFee: '0.3',
  rule_listing_age_limit_maxMinutes: '8',
  rule_top10_holder_limit_maxPercent: '50',
  rule_sybil_protection_minPercent: '15',
  rule_dev_hold_limit_maxPercent: '30',
  rule_bundle_limit_maxPercent: '10',
  rule_dev_risk_check_maxRiskScore: '50',
  rule_whale_buy_concentration_maxTotalSol: '15',
  rule_first_7_buyers_hold_limit_maxPercent: '25',
  rule_same_buy_amount_tolerancePercent: '10',
  rule_new_wallet_accumulation_checkFirstXBuyers: '5',
  rule_new_wallet_accumulation_maxAccumulationPercent: '25',
  rule_new_wallet_total_hold_limit_maxPercent: '15',
  rule_early_buyer_count_check_minCount: '5',

  // Monitoring (KHÔNG override — tôn trọng giá trị user đã chỉnh)
  // earlyBuyersToMonitor, minBuyersToPass, globalFeeThreshold giữ nguyên
};

function main() {
  console.log(`\n🛠️  Apply Optimal Config Migration\n   DB: ${DB_PATH}\n   Mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'WRITE'}\n`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Đảm bảo bot_settings tồn tại
  db.exec(`CREATE TABLE IF NOT EXISTS bot_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const getStmt = db.prepare('SELECT value FROM bot_settings WHERE key = ?');
  const upsertStmt = db.prepare(`
    INSERT INTO bot_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);

  let changed = 0;
  let unchanged = 0;
  let added = 0;

  console.log('Key                                                       | Before          | After');
  console.log('----------------------------------------------------------+-----------------+---------------');

  const entries = Object.entries(SETTINGS_UPDATES);
  const plan = entries.map(([key, newValue]) => {
    const row = getStmt.get(key);
    const before = row ? row.value : '<unset>';
    const status = before === newValue ? '=' : (row ? 'Δ' : '+');
    const padKey = key.padEnd(57, ' ');
    const padBefore = String(before).padEnd(15, ' ');
    console.log(`${status} ${padKey} | ${padBefore} | ${newValue}`);
    if (status === '=') unchanged++;
    else if (status === '+') added++;
    else changed++;
    return { key, newValue, status };
  });

  if (!DRY_RUN) {
    const tx = db.transaction(() => {
      for (const item of plan) {
        upsertStmt.run(item.key, item.newValue);
      }
    });
    tx();
  }

  console.log('\n📊 Summary:');
  console.log(`   Changed:    ${changed}`);
  console.log(`   Added:      ${added}`);
  console.log(`   Unchanged:  ${unchanged}`);
  console.log(`   Total:      ${entries.length}`);

  // Hiển thị cấu hình hiện tại của các rule mới
  console.log('\n📋 Current state of new rules:');
  for (const k of [
    'rule_launch_mcap_ceiling',
    'rule_launch_mcap_ceiling_maxMarketCapSol',
    'rule_whale_buy_concentration',
    'rule_whale_buy_concentration_maxTotalSol',
    'rule_sybil_protection',
    'rule_sybil_protection_minPercent',
    'rule_market_cap_check_minMarketCapSol',
    'rule_top10_holder_limit_maxPercent',
    'rule_dev_hold_limit_maxPercent',
    'rule_bundle_limit_maxPercent',
  ]) {
    const v = getStmt.get(k);
    console.log(`   ${k.padEnd(50)} = ${v?.value ?? '<unset>'}`);
  }

  db.close();

  if (DRY_RUN) {
    console.log('\n✅ DRY-RUN complete. Re-run without --dry-run to apply.');
  } else {
    console.log('\n✅ Migration applied. Restart bot to load new config.');
    console.log('   Lệnh:  npm start  (hoặc cách bạn đang chạy bot)');
  }
}

main();
