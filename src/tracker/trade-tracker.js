const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');
const { formatSol } = require('../utils/helpers');

class TradeTracker {
  constructor() {
    this.db = null;
  }

  /**
   * Initialize SQLite database for trade history
   */
  init() {
    const dbPath = path.join(__dirname, '../../data/trades.db');

    // Ensure data directory exists
    const fs = require('fs');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000'); // 64MB cache
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('mmap_size = 268435456'); // 256MB mmap


    this._createTables();
    this._migrate();
    logger.info('Trade tracker initialized');
    return this;
  }

  /**
   * Get the timestamp of the most recent 9:00 AM (Vietnam/Local time)
   */
  _getRecent9AM() {
    const now = new Date();
    const nineAM = new Date(now);
    nineAM.setHours(9, 0, 0, 0);
    
    // If current time is before 9 AM today, use 9 AM yesterday
    if (now < nineAM) {
      nineAM.setDate(nineAM.getDate() - 1);
    }
    return nineAM.getTime();
  }

  _migrate() {
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(passed_tokens)").all();
      const newColumns = [
        ['launch_mcap_sol', 'REAL'],
        ['highest_mcap_sol', 'REAL'],
        ['current_mcap_sol', 'REAL'],
        ['current_mcap_usd', 'REAL']
      ];

      for (const [columnName, columnType] of newColumns) {
        if (!tableInfo.some(col => col.name === columnName)) {
          this.db.exec(`ALTER TABLE passed_tokens ADD COLUMN ${columnName} ${columnType};`);
          logger.info(`Migration: Added ${columnName} to passed_tokens`);
        }
      }
    } catch (err) {
      logger.error(`Migration for passed_tokens failed: ${err.message}`);
    }

    try {
      const scanTableInfo = this.db.prepare("PRAGMA table_info(token_scans)").all();
      const jsonColumns = [
        ['dev_analysis_json', 'TEXT'],
        ['token_score_json', 'TEXT'],
        ['holder_stats_json', 'TEXT'],
        ['cluster_analysis_json', 'TEXT'],
        ['early_buyers_json', 'TEXT'],
        ['early_buyer_trades_json', 'TEXT'],
      ];

      for (const [columnName, columnType] of jsonColumns) {
        if (!scanTableInfo.some(col => col.name === columnName)) {
          this.db.exec(`ALTER TABLE token_scans ADD COLUMN ${columnName} ${columnType};`);
          logger.info(`Migration: Added ${columnName} to token_scans`);
        }
      }
    } catch (err) {
      logger.error(`Scan migration failed: ${err.message}`);
    }


  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        token_name TEXT,
        token_symbol TEXT,
        action TEXT NOT NULL,
        sol_amount REAL NOT NULL,
        token_amount REAL,
        signature TEXT,
        reason TEXT,
        pnl_sol REAL DEFAULT 0,
        pnl_percent REAL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS token_scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        token_name TEXT,
        token_symbol TEXT,
        deployer TEXT,
        dev_risk_score INTEGER,
        token_score INTEGER,
        market_cap_sol REAL, -- Added for MCap synchronization
        cluster_detected INTEGER DEFAULT 0,
        rule_result TEXT, -- JSON string of results
        dev_analysis_json TEXT,
        token_score_json TEXT,
        holder_stats_json TEXT,
        cluster_analysis_json TEXT,
        early_buyers_json TEXT,
        early_buyer_trades_json TEXT,
        action_taken TEXT,
        timestamp INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS detected_tokens (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        name TEXT,
        timestamp INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT PRIMARY KEY,
        tokens_scanned INTEGER DEFAULT 0,
        tokens_bought INTEGER DEFAULT 0,
        tokens_sold INTEGER DEFAULT 0,
        total_pnl_sol REAL DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS passed_tokens (
        mint TEXT PRIMARY KEY,
        symbol TEXT,
        launch_mcap_usd REAL,
        launch_mcap_sol REAL,
        highest_mcap_usd REAL,
        highest_mcap_sol REAL,
        current_mcap_usd REAL,
        current_mcap_sol REAL,
        highest_mcap_timestamp INTEGER,
        timestamp INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bot_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );



      CREATE TABLE IF NOT EXISTS real_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        token_symbol TEXT,
        token_name TEXT,
        buy_amount_sol REAL NOT NULL,
        token_amount REAL DEFAULT 0,
        entry_market_cap_sol REAL,
        current_market_cap_sol REAL,
        highest_market_cap_sol REAL,
        signature TEXT,
        status TEXT NOT NULL DEFAULT 'OPEN',
        entry_timestamp INTEGER NOT NULL,
        exit_timestamp INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
      CREATE INDEX IF NOT EXISTS idx_scans_mint ON token_scans(mint);
      CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON token_scans(timestamp);
      CREATE INDEX IF NOT EXISTS idx_passed_tokens_ts ON passed_tokens(timestamp);
      CREATE INDEX IF NOT EXISTS idx_detected_tokens_ts ON detected_tokens(timestamp);

      CREATE INDEX IF NOT EXISTS idx_real_positions_status ON real_positions(status);
      CREATE INDEX IF NOT EXISTS idx_real_positions_mint ON real_positions(mint);
    `);
  }

  // ─── Trade Recording ──────────────────────────────────────────────

  recordBuy(data) {
    const stmt = this.db.prepare(`
      INSERT INTO trades (mint, token_name, token_symbol, action, sol_amount, token_amount, signature, reason, timestamp)
      VALUES (?, ?, ?, 'BUY', ?, ?, ?, ?, ?)
    `);

    stmt.run(
      data.mint,
      data.tokenName || null,
      data.tokenSymbol || null,
      data.solAmount,
      data.tokenAmount || null,
      data.signature || null,
      data.reason || 'AUTO',
      data.timestamp || Date.now()
    );

    this._updateDailyStats('bought');
    logger.debug(`Trade recorded: BUY ${data.tokenSymbol || data.mint}`);
  }

  recordSell(data) {
    const stmt = this.db.prepare(`
      INSERT INTO trades (mint, token_name, token_symbol, action, sol_amount, token_amount, signature, reason, pnl_sol, pnl_percent, timestamp)
      VALUES (?, ?, ?, 'SELL', ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      data.mint,
      data.tokenName || null,
      data.tokenSymbol || null,
      data.solAmount || 0,
      data.tokenAmount || null,
      data.signature || null,
      data.reason || 'MANUAL',
      data.pnlSol || 0,
      data.pnlPercent || 0,
      data.timestamp || Date.now()
    );

    this._updateDailyStats('sold', data.pnlSol || 0);
    logger.debug(`Trade recorded: SELL ${data.tokenSymbol || data.mint} (PnL: ${formatSol(data.pnlSol || 0)})`);
  }

  recordScan(data) {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO token_scans (
          mint,
          token_name,
          token_symbol,
          deployer,
          dev_risk_score,
          token_score,
          cluster_detected,
          rule_result,
          dev_analysis_json,
          token_score_json,
          holder_stats_json,
          cluster_analysis_json,
          early_buyers_json,
          early_buyer_trades_json,
          action_taken,
          timestamp
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        data.mint,
        data.tokenName || null,
        data.tokenSymbol || null,
        data.deployer || null,
        data.devRiskScore || null,
        data.tokenScore || null,
        data.clusterDetected ? 1 : 0,
        JSON.stringify(data.ruleResult), // Must be JSON string for web dashboard
        data.devAnalysis ? JSON.stringify(data.devAnalysis) : null,
        data.tokenScoreDetails ? JSON.stringify(data.tokenScoreDetails) : null,
        data.holderStats ? JSON.stringify(data.holderStats) : null,
        data.clusterAnalysis ? JSON.stringify(data.clusterAnalysis) : null,
        data.earlyBuyers ? JSON.stringify(data.earlyBuyers) : null,
        data.earlyBuyerTrades ? JSON.stringify(data.earlyBuyerTrades) : null,
        data.actionTaken || null,
        data.timestamp || Date.now()
      );

      this._updateDailyStats('scanned');
    } catch (err) {
      logger.error(`Failed to record scan for ${data.mint}: ${err.message}`);
    }
  }

  recordDetectedToken(data) {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO detected_tokens (mint, symbol, name, timestamp)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(mint) DO UPDATE SET timestamp = excluded.timestamp
      `);
      stmt.run(data.mint, data.symbol, data.name, data.timestamp || Date.now());
    } catch (err) {
      logger.error(`Failed to record detected token ${data.symbol}: ${err.message}`);
    }
  }

  recordPassedToken(data) {
    if (!this.db) return;
    try {
      // NOTE: ON CONFLICT intentionally does NOT update launch_mcap columns
      // to preserve the original market cap at pass alert as the baseline.
      const stmt = this.db.prepare(`
        INSERT INTO passed_tokens (
          mint, 
          symbol, 
          launch_mcap_usd, 
          launch_mcap_sol,
          highest_mcap_usd, 
          highest_mcap_sol,
          current_mcap_usd, 
          current_mcap_sol,
          highest_mcap_timestamp, 
          timestamp
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mint) DO UPDATE SET 
          highest_mcap_usd = MAX(highest_mcap_usd, excluded.highest_mcap_usd),
          highest_mcap_sol = MAX(highest_mcap_sol, excluded.highest_mcap_sol),
          current_mcap_usd = excluded.current_mcap_usd,
          current_mcap_sol = excluded.current_mcap_sol,
          highest_mcap_timestamp = CASE WHEN excluded.highest_mcap_usd > highest_mcap_usd THEN excluded.highest_mcap_timestamp ELSE highest_mcap_timestamp END
      `);
      stmt.run(
        data.mint,
        data.symbol,
        data.launchMcapUsd,
        data.launchMcapSol || 0,
        data.highestMcapUsd || data.launchMcapUsd,
        data.highestMcapSol || data.launchMcapSol || 0,
        data.highestMcapUsd || data.launchMcapUsd,
        data.highestMcapSol || data.launchMcapSol || 0,
        data.highestMcapTimestamp || Date.now(),
        data.timestamp || Date.now()
      );
    } catch (err) {
      logger.error(`Failed to record passed token ${data.symbol}: ${err.message}`);
    }
  }

  recordRealPositionOpen(data) {
    if (!this.db) return null;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO real_positions (
          mint,
          token_symbol,
          token_name,
          buy_amount_sol,
          token_amount,
          entry_market_cap_sol,
          current_market_cap_sol,
          highest_market_cap_sol,
          signature,
          status,
          entry_timestamp,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, CURRENT_TIMESTAMP)
      `);

      const result = stmt.run(
        data.mint,
        data.tokenSymbol || null,
        data.tokenName || null,
        data.buyAmountSol,
        data.tokenAmount || 0,
        data.entryMarketCapSol || null,
        data.entryMarketCapSol || null,
        data.entryMarketCapSol || null,
        data.signature || null,
        data.entryTimestamp || Date.now()
      );

      return result.lastInsertRowid;
    } catch (err) {
      logger.error(`Failed to record REAL POSITION for ${data.mint}: ${err.message}`);
      return null;
    }
  }

  updateRealPositionSnapshot(data) {
    if (!this.db || !data?.mint) return;
    try {
      this.db.prepare(`
        UPDATE real_positions
        SET current_market_cap_sol = ?,
            highest_market_cap_sol = MAX(highest_market_cap_sol, ?),
            token_amount = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE mint = ? AND status = 'OPEN'
      `).run(
        data.currentMarketCapSol || 0,
        data.currentMarketCapSol || 0,
        data.tokenAmount || 0,
        data.mint
      );
    } catch (err) {
      logger.error(`Failed to update REAL POSITION snapshot for ${data.mint}: ${err.message}`);
    }
  }

  closeRealPosition(mint, reason = 'SOLD') {
    if (!this.db) return;
    try {
      this.db.prepare(`
        UPDATE real_positions
        SET status = 'CLOSED',
            exit_timestamp = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE mint = ? AND status = 'OPEN'
      `).run(Date.now(), mint);
    } catch (err) {
      logger.error(`Failed to close REAL POSITION for ${mint}: ${err.message}`);
    }
  }

  // ─── Query Methods ────────────────────────────────────────────────

  getTradeHistory(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?
    `).all(limit);
  }

  getOpenRealPositions() {
    if (!this.db) return [];
    try {
      return this.db.prepare(`
        SELECT *
        FROM real_positions
        WHERE status = 'OPEN'
        ORDER BY entry_timestamp DESC
      `).all();
    } catch (err) {
      logger.error(`Failed to get open REAL positions: ${err.message}`);
      return [];
    }
  }

  getTradesForMint(mint) {
    return this.db.prepare(`
      SELECT * FROM trades WHERE mint = ? ORDER BY timestamp ASC
    `).all(mint);
  }

  getTodayStats() {
    const today = new Date().toISOString().split('T')[0];
    const stats = this.db.prepare(`
      SELECT * FROM daily_stats WHERE date = ?
    `).get(today);

    if (!stats) {
      return {
        date: today,
        tokensScanned: 0,
        tokensBought: 0,
        tokensSold: 0,
        totalPnlSol: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
      };
    }

    const passedCount = this.db.prepare(`SELECT COUNT(*) as count FROM passed_tokens`).get().count;
    const sincePassedHistory = Date.now() - 24 * 60 * 60 * 1000;
    const passed24h = this.db.prepare(`SELECT COUNT(*) as count FROM passed_tokens WHERE timestamp > ?`).get(sincePassedHistory).count;

    return {
      date: stats.date,
      tokensScanned: stats.tokens_scanned,
      tokensBought: stats.tokens_bought,
      tokensSold: stats.tokens_sold,
      totalPnlSol: stats.total_pnl_sol,
      wins: stats.wins,
      losses: stats.losses,
      totalPassed: passedCount,
      passed24h: passed24h,
      winRate: stats.wins + stats.losses > 0
        ? (stats.wins / (stats.wins + stats.losses)) * 100
        : 0,
    };
  }

  getDailyLoss() {
    const today = new Date().toISOString().split('T')[0];
    const stats = this.db.prepare(`
      SELECT total_pnl_sol FROM daily_stats WHERE date = ?
    `).get(today);

    return stats ? Math.abs(Math.min(stats.total_pnl_sol, 0)) : 0;
  }

  updateHighestMcap(mint, mcapUsd, timestamp, mcapSol = null) {
    if (!this.db) return;
    try {
      this.db.prepare(`
        UPDATE passed_tokens 
        SET highest_mcap_usd = ?, 
            highest_mcap_sol = COALESCE(?, highest_mcap_sol),
            highest_mcap_timestamp = ?
        WHERE mint = ? AND highest_mcap_usd < ?
      `).run(mcapUsd, mcapSol, timestamp, mint, mcapUsd);
    } catch (err) {
      logger.error(`Failed to update highest mcap for ${mint}: ${err.message}`);
    }
  }

  updateCurrentMcap(mint, mcapUsd, mcapSol = null) {
    if (!this.db) return;
    try {
      this.db.prepare(`
        UPDATE passed_tokens 
        SET current_mcap_usd = ?,
            current_mcap_sol = COALESCE(?, current_mcap_sol)
        WHERE mint = ?
      `).run(mcapUsd, mcapSol, mint);
    } catch (err) {
      logger.error(`Failed to update current mcap for ${mint}: ${err.message}`);
    }
  }

  getRecentScans(limit = 100) {
    if (!this.db) return [];
    try {
      return this.db.prepare(`
        SELECT * FROM token_scans ORDER BY timestamp DESC LIMIT ?
      `).all(limit);
    } catch (err) {
      logger.error(`Failed to get recent scans: ${err.message}`);
      return [];
    }
  }

  getScanForMint(mint) {
    if (!this.db) return null;
    try {
      return this.db.prepare(`
        SELECT * FROM token_scans WHERE mint = ? ORDER BY timestamp DESC LIMIT 1
      `).get(mint);
    } catch (err) {
      logger.error(`Failed to get scan for mint: ${err.message}`);
      return null;
    }
  }

  getPassedTokens24h() {
    if (!this.db) return [];
    try {
      // Return the most recent 200 passed tokens, regardless of time window
      // but still sort by timestamp DESC. This ensures data is never empty on reload.
      return this.db.prepare(`
        SELECT * FROM passed_tokens ORDER BY timestamp DESC LIMIT 200
      `).all();
    } catch (err) {
      logger.error(`Failed to get passed tokens: ${err.message}`);
      return [];
    }
  }

  getAllPassedTokens() {
    if (!this.db) return [];
    try {
      return this.db.prepare(`
        SELECT * FROM passed_tokens ORDER BY timestamp DESC
      `).all();
    } catch (err) {
      logger.error(`Failed to get all passed tokens: ${err.message}`);
      return [];
    }
  }

  getPassedTokenByMint(mint) {
    if (!this.db) return null;
    try {
      return this.db.prepare(`
        SELECT * FROM passed_tokens WHERE mint = ? LIMIT 1
      `).get(mint);
    } catch (err) {
      logger.error(`Failed to get passed token by mint: ${err.message}`);
      return null;
    }
  }

  /**
   * Reset all trade and scan data (Wipe DB tables)
   */
  resetData() {
    if (!this.db) return;
    try {
      const tables = [
        'trades',
        'daily_stats',
        'real_positions'
      ];

      for (const table of tables) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      
      logger.info('📊 Profit/Loss and Trade data has been RESET (Scanned tokens preserved)');
      return true;
    } catch (err) {
      logger.error(`Failed to reset data: ${err.message}`);
      return false;
    }
  }

  getTopPnLTokens(period = '24h', limit = 20) {
    if (!this.db) return [];
    try {
      if (period === 'all') {
        const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
        return this.db.prepare(`
          SELECT 
            *,
            (highest_mcap_usd / NULLIF(launch_mcap_usd, 0)) as pnl_multiplier
          FROM passed_tokens 
          WHERE (timestamp > ? OR highest_mcap_usd / launch_mcap_usd > 5)
            AND launch_mcap_usd > 0
          ORDER BY pnl_multiplier DESC
          LIMIT ?
        `).all(since, limit);
      } else {
        // period === '24h'
        const since = Date.now() - 24 * 60 * 60 * 1000;
        return this.db.prepare(`
          SELECT 
            *,
            (highest_mcap_usd / NULLIF(launch_mcap_usd, 0)) as pnl_multiplier
          FROM passed_tokens 
          WHERE timestamp > ?
            AND launch_mcap_usd > 0
          ORDER BY pnl_multiplier DESC
          LIMIT ?
        `).all(since, limit);
      }
    } catch (err) {
      logger.error(`Failed to get top PnL tokens: ${err.message}`);
      return [];
    }
  }

  /**
   * Win rate stats for 1D, 3D, 7D periods.
   * WIN = highest_mcap_usd / launch_mcap_usd >= 1.1 (x1.1)
   * LOSS = highest_mcap_usd / launch_mcap_usd <= 1.0
   * Tokens between 1.0 and 1.1 are excluded (undecided).
   */
  getWinRateStats() {
    if (!this.db) return { '1d': null, '3d': null, '7d': null };

    const periods = {
      '1d': this._getRecent9AM(), // Changed to 9 AM today
      '3d': Date.now() - 3 * 24 * 60 * 60 * 1000,
      '7d': Date.now() - 7 * 24 * 60 * 60 * 1000,
      'all': 0,
    };

    const result = {};

    for (const [key, since] of Object.entries(periods)) {
      try {
        const rows = this.db.prepare(`
          SELECT
            launch_mcap_usd,
            highest_mcap_usd
          FROM passed_tokens
          WHERE timestamp > ?
            AND launch_mcap_usd > 0
            AND highest_mcap_usd > 0
        `).all(since);

        let wins = 0;
        let losses = 0;
        let totalPnlPercent = 0;
        for (const row of rows) {
          const multiplier = row.highest_mcap_usd / row.launch_mcap_usd;
          if (multiplier >= 1.1) wins++;
          else if (multiplier <= 1.0) losses++;
          
          totalPnlPercent += (multiplier - 1) * 100;
        }

        const avgPnlPercent = rows.length > 0 ? totalPnlPercent / rows.length : 0;
        const total = wins + losses;
        result[key] = {
          wins,
          losses,
          total,
          winRate: total > 0 ? (wins / total) * 100 : 0,
          avgPnlPercent,
          totalTokens: rows.length,
        };
      } catch (err) {
        logger.error(`Failed to get win rate for ${key}: ${err.message}`);
        result[key] = { wins: 0, losses: 0, total: 0, winRate: 0, totalTokens: 0 };
      }
    }

    return result;
  }

  getRecentDetectedTokens(limit = 500) {
    if (!this.db) return [];
    try {
      // Use GROUP BY to ensure one entry per mint with the latest status
      return this.db.prepare(`
        SELECT 
          d.*,
          (SELECT action_taken FROM token_scans WHERE mint = d.mint ORDER BY timestamp DESC LIMIT 1) as status
        FROM detected_tokens d
        ORDER BY d.timestamp DESC 
        LIMIT ?
      `).all(limit);
    } catch (err) {
      logger.error(`Failed to get recent detected tokens: ${err.message}`);
      return [];
    }
  }

  getDetectedTokenByMint(mint) {
    if (!this.db) return null;
    try {
      return this.db.prepare(`
        SELECT * FROM detected_tokens WHERE mint = ? LIMIT 1
      `).get(mint);
    } catch (err) {
      logger.error(`Failed to get detected token by mint: ${err.message}`);
      return null;
    }
  }

  // ─── Private Methods ──────────────────────────────────────────────

  _updateDailyStats(type, pnl = 0) {
    const today = new Date().toISOString().split('T')[0];

    // Upsert daily stats
    this.db.prepare(`
      INSERT INTO daily_stats (date, tokens_scanned, tokens_bought, tokens_sold, total_pnl_sol, wins, losses)
      VALUES (?, 0, 0, 0, 0, 0, 0)
      ON CONFLICT(date) DO NOTHING
    `).run(today);

    if (type === 'scanned') {
      this.db.prepare(`UPDATE daily_stats SET tokens_scanned = tokens_scanned + 1, updated_at = CURRENT_TIMESTAMP WHERE date = ?`).run(today);
    } else if (type === 'bought') {
      this.db.prepare(`UPDATE daily_stats SET tokens_bought = tokens_bought + 1, updated_at = CURRENT_TIMESTAMP WHERE date = ?`).run(today);
    } else if (type === 'sold') {
      this.db.prepare(`
        UPDATE daily_stats SET
          tokens_sold = tokens_sold + 1,
          total_pnl_sol = total_pnl_sol + ?,
          wins = wins + CASE WHEN ? > 0 THEN 1 ELSE 0 END,
          losses = losses + CASE WHEN ? < 0 THEN 1 ELSE 0 END,
          updated_at = CURRENT_TIMESTAMP
        WHERE date = ?
      `).run(pnl, pnl, pnl, today);
    }
  }

  // ─── Bot Settings Persistence ──────────────────────────────────────

  saveRuleState(ruleId, enabled) {
    this.saveBotSetting(`rule_${ruleId}`, enabled ? 'true' : 'false');
  }

  saveBotSetting(key, value) {
    if (!this.db) {
      logger.warn(`Skipping save of ${key}: Database not initialized!`);
      return;
    }
    try {
      this.db.prepare(`
        INSERT INTO bot_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
      `).run(key, String(value), String(value));
      logger.debug(`Bot setting ${key} saved: ${value}`);
    } catch (err) {
      logger.error(`Failed to save bot setting ${key}: ${err.message}`);
    }
  }

  getBotSetting(key, defaultValue = null) {
    if (!this.db) return defaultValue;
    try {
      const row = this.db.prepare(`SELECT value FROM bot_settings WHERE key = ?`).get(key);
      return row ? row.value : defaultValue;
    } catch (err) {
      logger.error(`Failed to get bot setting ${key}: ${err.message}`);
      return defaultValue;
    }
  }

  getAllRuleStates() {
    if (!this.db) return {};
    try {
      // Only select toggle keys (value is 'true'/'false'), skip numeric param keys like rule_<id>_<param>
      const settings = this.db.prepare(`SELECT key, value FROM bot_settings WHERE key LIKE 'rule_%' AND value IN ('true', 'false')`).all();
      const states = {};
      settings.forEach(s => {
        const ruleId = s.key.replace('rule_', '');
        states[ruleId] = s.value === 'true';
      });
      return states;
    } catch (err) {
      logger.error(`Failed to get rule states: ${err.message}`);
      return {};
    }
  }

  close() {
    if (this.db) this.db.close();
  }
}

module.exports = new TradeTracker();
