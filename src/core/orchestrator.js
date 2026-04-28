const EventEmitter = require('events');
const { PublicKey } = require('@solana/web3.js');
const {
  unpackAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} = require('@solana/spl-token');
const settings = require('../config/settings');
const logger = require('../utils/logger');
const { shortenAddress, formatSol } = require('../utils/helpers');

const { SolanaConnection: solana, RPC_CATEGORY } = require('./solana-connection');
const detector = require('./pumpfun-detector');
const walletAnalyzer = require('../analyzers/wallet-analyzer');
const devAnalyzer = require('../analyzers/dev-analyzer');
const tokenScorer = require('../analyzers/token-scorer');
const ruleEngine = require('../engine/rule-engine');
const {
  applyRuleProfile,
  getRuleProfile,
  getRuleProfiles,
  markProfileAsCustom,
  persistAppliedRuleProfile,
} = require('../engine/rule-profiles');
const buyExecutor = require('../executor/buy-executor');
const sellExecutor = require('../executor/sell-executor');
const telegram = require('../telegram/telegram-bot');
const tracker = require('../tracker/trade-tracker');
const webServer = require('../web/server');
const priceService = require('../services/price-service');
const RescanScheduler = require('./rescan-scheduler');

class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.isPaused = false;
    this.tokenEarlyBuyers = new Map(); // mint -> [{ address, solAmount }]
    this.tokenData = new Map(); // mint -> token data
    this.tokenGlobalFees = new Map(); // mint -> cumulative trading fees (1% of volume)
    // Trade history per mint cho MEV detection. Lưu cả buy & sell, giới hạn 200 trade gần nhất.
    this.tokenTradeHistory = new Map(); // mint -> [{ trader, type, ts, signature }]
    // Pending trades nhận trước newToken event (race condition) — replay khi tokenData arrives
    this._pendingTrades = new Map(); // mint -> [tradeData, ...]
    this.processingTokens = new Set(); // tokens currently being analyzed
    this.passedTokens = new Set(); // tokens that successfully passed all rules
    this.analyzedTokens = new Set(); // track ALL tokens recorded to scans (pass or fail)
    this.holderStatsCache = new Map(); // mint -> { data, timestamp }
    this.pendingRechecks = new Map(); // legacy — kept for backward-compat cleanup
    this._safetyNetTimeouts = new Map(); // mint -> timeout id for 5s safety-net
    this._rescanAttempts = new Map(); // mint -> number of rescan attempts triggered (for UI sync + debug)
    this._recheckInterval = 5000; // legacy fallback
    this._analysisQueue = [];
    this.rescanScheduler = new RescanScheduler(this);
    // Slot pre-cache: signature → { slot, ts }. Nguồn: logsSubscribe trực tiếp PumpFun.
    // Mục đích: bundle detection không phải gọi lại getParsedTransaction chỉ để
    // lấy slot. Tip-account check vẫn cần parsed tx, nhưng có thể dùng slot
    // trực tiếp để skip slot-only fetches.
    this._slotCache = new Map();
    this._directLogsSubId = null;

    // Health metric: rolling-window count để phát hiện sớm khi pipeline mù
    // (vd. RPC fail hàng loạt, key bị revoke). Đã từng có phiên 99.4% fail
    // chạy âm thầm 35 phút không token nào pass — fix này tránh tái diễn.
    this._analysisHealth = {
      ok: 0,
      fail: 0,
      windowStartedAt: Date.now(),
      lastAlertAt: 0,
    };
    this._analysisHealthInterval = null;
  }

  async _loadTokenAccountOwners(accounts) {
    if (!accounts || accounts.length === 0) return [];

    const getAmount = (acc) => {
      if (typeof acc.amount === 'number' && Number.isFinite(acc.amount)) return acc.amount;
      if (acc.uiAmount != null) return acc.uiAmount;
      if (acc.uiAmountString) return parseFloat(acc.uiAmountString);
      return parseFloat(acc.amount);
    };

    const accountPubkeys = accounts.map((acc) => new PublicKey(
      acc.address?.toBase58 ? acc.address.toBase58() : String(acc.address)
    ));

    try {
      const infos = await solana.execute((conn) => conn.getMultipleAccountsInfo(accountPubkeys), RPC_CATEGORY.METADATA);

      return accounts.map((acc, index) => {
        const addr = accountPubkeys[index].toBase58();
        const info = infos?.[index] || null;
        let owner = null;

        try {
          if (info?.owner?.equals?.(TOKEN_PROGRAM_ID)) {
            owner = unpackAccount(accountPubkeys[index], info, TOKEN_PROGRAM_ID).owner.toBase58();
          } else if (info?.owner?.equals?.(TOKEN_2022_PROGRAM_ID)) {
            owner = unpackAccount(accountPubkeys[index], info, TOKEN_2022_PROGRAM_ID).owner.toBase58();
          }
        } catch (err) {
          logger.debug(`Failed to decode token account ${shortenAddress(addr)}: ${err.message}`);
        }

        return {
          addr,
          owner,
          amount: getAmount(acc),
        };
      });
    } catch (err) {
      logger.debug(`Batch token-account owner load failed: ${err.message}`);

      return Promise.all(accounts.map(async (acc) => {
        const addr = acc.address?.toBase58 ? acc.address.toBase58() : String(acc.address);
        try {
          const parsed = await solana.execute((conn) => conn.getParsedAccountInfo(new PublicKey(addr)));
          return {
            addr,
            owner: parsed?.value?.data?.parsed?.info?.owner || null,
            amount: getAmount(acc),
          };
        } catch (innerErr) {
          logger.debug(`Failed to parse token account ${shortenAddress(addr)}: ${innerErr.message}`);
          return {
            addr,
            owner: null,
            amount: getAmount(acc),
          };
        }
      }));
    }
  }

  _isLikelyFunctionalOwner(owner, excludedOwners = new Set()) {
    if (!owner) return false;
    if (excludedOwners.has(owner)) return true;

    try {
      return !PublicKey.isOnCurve(new PublicKey(owner).toBytes());
    } catch (err) {
      return false;
    }
  }

  _clearPendingRecheck(mint) {
    this.rescanScheduler.cancel(mint);
    const pending = this.pendingRechecks.get(mint);
    if (pending) {
      clearTimeout(pending);
      this.pendingRechecks.delete(mint);
    }
  }

  _scheduleRecheck(mint, _delayMs, reason) {
    this.rescanScheduler.schedule(mint, { reason });
  }

  /**
   * Initialize all components and start the bot
   */
  async start() {
    logger.info('═══════════════════════════════════════════');
    logger.info('   SCAN SOL BOT - PumpFun Sniper');
    logger.info('═══════════════════════════════════════════');

    // 1. Initialize Solana connection (preflight probe — drop dead RPC trước khi vào pool)
    await solana.init();
    if (solana.getWallet()) {
      const balance = await solana.getBalance();
      logger.info(`Wallet balance: ${formatSol(balance)}`);
    } else {
      logger.info('Running in MONITOR-ONLY mode (no wallet)');
    }

    // 2. Initialize trade tracker (SQLite)
    tracker.init();

    // 2.5. Load open positions from DB so TP/SL monitoring resumes after restart
    sellExecutor.init();

    // 3. Load persistent settings from DB
    const savedRuleStates = tracker.getAllRuleStates();
    ruleEngine.loadStates(savedRuleStates);
    {
      const savedProfile = tracker.getBotSetting('activeRuleProfile', 'custom');
      const knownIds = new Set(require('../engine/rule-profiles').getRuleProfiles().map((p) => p.id));
      const validProfile = (savedProfile === 'custom' || knownIds.has(savedProfile)) ? savedProfile : 'custom';
      if (validProfile !== savedProfile) {
        tracker.saveBotSetting('activeRuleProfile', validProfile);
        logger.info(`Migrated activeRuleProfile "${savedProfile}" → "${validProfile}" (profile no longer exists)`);
      }
      ruleEngine.setActiveProfile(validProfile);
    }
    
    const savedAutoBuy = tracker.getBotSetting('autoBuyEnabled');
    if (savedAutoBuy !== null) {
      settings.trading.autoBuyEnabled = savedAutoBuy === 'true';
    }

    const savedAutoSell = tracker.getBotSetting('autoSellEnabled');
    if (savedAutoSell !== null) {
      settings.trading.autoSellEnabled = savedAutoSell === 'true';
    }

    const savedBuyAmount = tracker.getBotSetting('buyAmountSol');
    if (savedBuyAmount !== null) {
      settings.trading.buyAmountSol = parseFloat(savedBuyAmount);
    }

    const savedTakeProfit = tracker.getBotSetting('takeProfitPercent');
    if (savedTakeProfit !== null) {
      settings.risk.takeProfitPercent = parseFloat(savedTakeProfit);
    }

    const savedStopLoss = tracker.getBotSetting('stopLossPercent');
    if (savedStopLoss !== null) {
      settings.risk.stopLossPercent = parseFloat(savedStopLoss);
    }

    const savedMaxPositions = tracker.getBotSetting('maxConcurrentPositions');
    if (savedMaxPositions !== null) {
      settings.trading.maxConcurrentPositions = parseInt(savedMaxPositions, 10);
    }

    const savedDailyLossLimit = tracker.getBotSetting('dailyLossLimitSol');
    if (savedDailyLossLimit !== null) {
      settings.trading.dailyLossLimitSol = parseFloat(savedDailyLossLimit);
    }

    const savedEarlyBuyersCount = tracker.getBotSetting('earlyBuyersToMonitor');
    if (savedEarlyBuyersCount !== null) {
      settings.monitoring.earlyBuyersToMonitor = parseInt(savedEarlyBuyersCount, 10);
    }

    const savedMinBuyers = tracker.getBotSetting('minBuyersToPass');
    if (savedMinBuyers !== null) {
      settings.monitoring.minBuyersToPass = parseInt(savedMinBuyers, 10);
    }

    const savedShowAll = tracker.getBotSetting('showAllEarlyBuyers');
    if (savedShowAll !== null) {
      settings.monitoring.showAllEarlyBuyers = savedShowAll === 'true';
    }

    const savedGlobalFee = tracker.getBotSetting('globalFeeThreshold');
    if (savedGlobalFee !== null) {
      settings.monitoring.globalFeeThreshold = parseFloat(savedGlobalFee);
    }

    const savedBuySlippage = tracker.getBotSetting('buySlippage');
    if (savedBuySlippage !== null) {
      settings.trading.buySlippage = parseInt(savedBuySlippage, 10);
    }

    const savedSellSlippage = tracker.getBotSetting('sellSlippage');
    if (savedSellSlippage !== null) {
      settings.trading.sellSlippage = parseInt(savedSellSlippage, 10);
    }

    // Load all saved numeric rule parameters generically
    for (const rule of ruleEngine.getRules()) {
      const numericEntries = Object.entries(rule).filter(([key, value]) => (
        typeof value === 'number' && Number.isFinite(value)
      ));

      for (const [param] of numericEntries) {
        const savedValue = tracker.getBotSetting(`rule_${rule.id}_${param}`);
        if (savedValue !== null) {
          ruleEngine.updateRule(rule.id, { [param]: parseFloat(savedValue) });
        }
      }
    }

    const mcapRule = ruleEngine.rules.get('market_cap_check');
    const ageRule = ruleEngine.rules.get('listing_age_limit');
    logger.info(`Loaded persistent settings (Auto-Buy: ${settings.trading.autoBuyEnabled}, Amount: ${settings.trading.buyAmountSol} SOL, Min MCap: ${mcapRule?.minMarketCapSol || settings.rules.minMarketCapSol} SOL, Max Age: ${ageRule?.maxMinutes || settings.rules.maxMinutes}m)`);

    // ENV-SYNC: Ghi lại .env với giá trị thực đang chạy (sau DB restore)
    const { syncToEnv } = require('../config/env-sync');
    syncToEnv(settings, ruleEngine);
    logger.info('ENV-SYNC: .env synchronized with live settings');

    // 4. Initialize Telegram bot (non-blocking)
    telegram.init((command, params) => this._handleTelegramCommand(command, params));
    telegram.start().catch(err => logger.error(`Telegram start error: ${err.message}`));

    // 4. Start PumpFun detector
    detector.start();

    // 5. Set up event handlers
    this._setupEventHandlers();

    // 8. Start cleanup timer for "Timed out" tokens
    this._startCleanupTimer();

    // Start dynamic rescan scheduler (replaces static setTimeout rechecks)
    this.rescanScheduler.start();

    // Start direct logs subscription (slot pre-cache)
    this._startDirectLogsSubscription();

    logger.info('Bot is now running and monitoring PumpFun...');
    logger.info(`Auto-buy: ${settings.trading.autoBuyEnabled ? 'ON' : 'OFF'}`);
    logger.info(`Buy amount: ${formatSol(settings.trading.buyAmountSol)}`);
    logger.info(`Monitoring ${settings.monitoring.earlyBuyersToMonitor} early buyers per token`);
    logger.info(`TP: ${settings.risk.takeProfitPercent}% | SL: ${settings.risk.stopLossPercent}%`);

    // 9. Start periodic web data synchronization
    this._startWebSync();

    // 10. Start Safety Stop Loss checker (every 60s)
    this._startSafetyCheck();

    // 11. Start periodic DB cleanup (giữ DB nhỏ gọn, tránh phình > 1GB)
    this._startDbCleanup();

    // 12. Start analysis-health monitor — phát hiện sớm khi RPC mù
    this._startAnalysisHealthMonitor();
  }

  /**
   * Mỗi 5 phút, đo tỉ lệ analysis fail. Nếu fail rate > ngưỡng và mẫu đủ lớn,
   * gửi cảnh báo Telegram + log FATAL. Tránh tình trạng bot chạy âm thầm 30+ phút
   * không có token nào pass do RPC issue (đã từng xảy ra: phiên 8:42-9:17 sáng nay,
   * 99.4% fail, 0 alert).
   */
  _startAnalysisHealthMonitor() {
    const intervalMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '300000', 10); // 5 min
    const failRateThreshold = parseFloat(process.env.HEALTH_FAIL_RATE_THRESHOLD || '0.5'); // 50%
    const minSampleSize = parseInt(process.env.HEALTH_MIN_SAMPLE || '20', 10);
    const alertCooldownMs = parseInt(process.env.HEALTH_ALERT_COOLDOWN_MS || '900000', 10); // 15 min

    if (this._analysisHealthInterval) clearInterval(this._analysisHealthInterval);
    this._analysisHealthInterval = setInterval(() => {
      const h = this._analysisHealth;
      const total = h.ok + h.fail;
      const windowMin = ((Date.now() - h.windowStartedAt) / 60000).toFixed(1);

      if (total >= minSampleSize) {
        const failRate = h.fail / total;
        if (failRate >= failRateThreshold && (Date.now() - h.lastAlertAt) > alertCooldownMs) {
          h.lastAlertAt = Date.now();
          const msg = `🚨 <b>BOT MÙ</b> — analysis fail rate ${(failRate * 100).toFixed(1)}% (${h.fail}/${total}) trong ${windowMin} phút.\nKhả năng cao do RPC: kiểm tra Helius key + .env.`;
          logger.fatal(msg.replace(/<[^>]+>/g, ''));
          telegram.sendMessage(msg).catch(e => logger.error(`Health alert telegram failed: ${e.message}`));
        } else {
          logger.info(`📊 Analysis health (${windowMin}m): ok=${h.ok} fail=${h.fail} (${(failRate * 100).toFixed(1)}% fail)`);
        }
      }

      // Reset window
      this._analysisHealth = { ok: 0, fail: 0, windowStartedAt: Date.now(), lastAlertAt: h.lastAlertAt };
    }, intervalMs);
  }

  _startDbCleanup() {
    const cfg = settings.dbCleanup || {};
    if (!cfg.enabled) {
      logger.info('🗑️ DB cleanup: disabled (DB_CLEANUP_ENABLED=false)');
      return;
    }

    const intervalMs = (cfg.runIntervalHours || 24) * 60 * 60 * 1000;
    const runOnce = () => {
      try {
        tracker.cleanup({
          keepScansDays: cfg.keepScansDays || 7,
          keepDetectedDays: cfg.keepDetectedDays || 14,
          runVacuum: false, // VACUUM nặng, để chạy bằng tay khi cần
        });
      } catch (err) {
        logger.error(`DB cleanup error: ${err.message}`);
      }
    };

    // Lần đầu sau 5 phút (cho bot khởi động xong, RPC ổn định)
    setTimeout(runOnce, 5 * 60 * 1000);
    this.dbCleanupInterval = setInterval(runOnce, intervalMs);
    logger.info(`🗑️ DB cleanup scheduled: keep ${cfg.keepScansDays}d scans, ${cfg.keepDetectedDays}d detected, every ${cfg.runIntervalHours}h`);
  }

  /**
   * Set up all event handlers
   */
  _setupEventHandlers() {
    // New token detected on PumpFun
    detector.on('newToken', (tokenData) => {
      if (this.isPaused) return;
      this._onNewToken(tokenData);
    });

    // Trade event on bonding curve
    detector.on('trade', (tradeData) => {
      if (this.isPaused) return;
      this._onTrade(tradeData);
    });

    // PumpFun disconnected
    detector.on('disconnected', () => {
      logger.error('PumpFun WebSocket disconnected permanently');
      telegram.sendMessage('🔴 *PumpFun WebSocket disconnected!* Bot needs restart.');
    });
  }

  _startWebSync() {
    // Initial sync
    this._syncWebData();

    // Periodic sync every 30s
    this.webSyncInterval = setInterval(() => {
      this._syncWebData();
    }, 30000);
  }

  async _syncWebData() {
    if (!webServer) return;
    try {
      const [wallet, positions] = await Promise.all([
        solana.getWalletSummary(),
        sellExecutor.getPositions()
      ]);

      if (wallet) {
        webServer.emit('realWalletUpdate', wallet);
      }
      
      webServer.emit('realPositionsUpdate', positions);
    } catch (err) {
      logger.debug(`Web sync error: ${err.message}`);
    }
  }

  _startSafetyCheck() {
    // Initial check after 30s
    setTimeout(() => this._syncSafetySL(), 30000);

    // Periodic check every 60s
    this.safetyCheckInterval = setInterval(() => {
      this._syncSafetySL();
    }, 60000);
  }

  async _syncSafetySL() {
    try {
      const actions = await sellExecutor.checkSafetyStopLosses();
      if (actions && actions.length > 0) {
        logger.info(`🛡️ Safety SL/TP: Found ${actions.length} tokens to sell.`);
        for (const action of actions) {
          // Check if still worth selling (current PnL stays at threshold)
          await this._executeSell(action);
        }
      }
    } catch (err) {
      logger.error(`Safety monitoring error: ${err.message}`);
    }
  }

  /**
   * Handle new token creation event
   */
  async _onNewToken(tokenData) {
    const mint = tokenData.mint;

    // Store token data
    this.tokenData.set(mint, tokenData);
    this.tokenEarlyBuyers.set(mint, []);
    this.tokenGlobalFees.set(mint, 0);

    // Subscribe to trades for this token
    detector.subscribeToToken(mint);

    // Replay pending trades đã đến trước newToken event (race condition fix)
    const pending = this._pendingTrades.get(mint);
    if (pending && pending.length > 0) {
      logger.info(`🔄 Replay ${pending.length} pending trade(s) for ${tokenData.symbol} (race-condition fix)`);
      this._pendingTrades.delete(mint);
      // Defer để tokenEarlyBuyers Map đã được set xong
      setImmediate(() => {
        for (const tradeData of pending) {
          try { this._onTrade(tradeData); } catch (err) {
            logger.debug(`Replay trade error: ${err.message}`);
          }
        }
      });
    }

    // Record to database for persistence
    tracker.recordDetectedToken({
      mint,
      symbol: tokenData.symbol,
      name: tokenData.name,
      timestamp: tokenData.timestamp
    });

    logger.info(`New token: ${tokenData.symbol} | Deployer: ${shortenAddress(tokenData.deployer)} | MCap: ${tokenData.marketCapSol?.toFixed(2)} SOL`);

    // If deployer made an initial buy, add as first early buyer and trigger analysis.
    // CẦN signature để _detectBundleWallets resolve được slot create — nếu không deployer
    // không bao giờ được tính vào bundle slot dù thật sự nằm trong slot create.
    if (tokenData.solAmount > 0) {
      this.tokenEarlyBuyers.get(mint).push({
        address: tokenData.deployer,
        solAmount: tokenData.solAmount || 0,
        tokenAmount: tokenData.tokenAmount || 0,
        timestamp: Date.now(),
        signature: tokenData.signature || null,
        slot: null, // sẽ resolve từ _slotCache hoặc getParsedTransaction
      });
      logger.info(`👤 Buyer #1/${settings.monitoring.earlyBuyersToMonitor} for ${tokenData.symbol}: ${shortenAddress(tokenData.deployer)} (${(tokenData.solAmount || 0).toFixed(4)} SOL) [deployer initial buy]`);

      // Trigger progressive analysis immediately on first buyer
      if (!this.passedTokens.has(mint) && !this.processingTokens.has(mint)) {
        this.processingTokens.add(mint);
        if (!this._analysisQueue) this._analysisQueue = [];
        this._analysisQueue.push(mint);
        this._processAnalysisQueue();
      }
    }

    // Emit to real-time dashboard
    webServer.emit('newToken', {
      mint,
      name: tokenData.name,
      symbol: tokenData.symbol,
      deployer: tokenData.deployer,
      marketCapSol: tokenData.marketCapSol,
      vSolInBondingCurve: tokenData.vSolInBondingCurve,
      solAmount: tokenData.solAmount,
      timestamp: tokenData.timestamp
    });

    // Safety net: if no buyer arrives within 5s (trade missed due to race condition),
    // force analysis with whatever data we have so the token isn't silently dropped
    const safetyTimeout = setTimeout(() => {
      this._safetyNetTimeouts.delete(mint);
      const buyers = this.tokenEarlyBuyers.get(mint);
      if (buyers && buyers.length === 0 && !this.analyzedTokens.has(mint) && !this.processingTokens.has(mint) && this.tokenData.has(mint)) {
        logger.info(`⚠️ No buyer detected for ${tokenData.symbol} after 5s — possible missed trades. Queuing safety analysis.`);
        // Add deployer as placeholder buyer for basic analysis
        buyers.push({
          address: tokenData.deployer,
          solAmount: 0,
          tokenAmount: 0,
          timestamp: Date.now(),
          signature: tokenData.signature || null,
          slot: null,
        });
        this.processingTokens.add(mint);
        if (!this._analysisQueue) this._analysisQueue = [];
        this._analysisQueue.push(mint);
        this._processAnalysisQueue();
      }
    }, 5000);
    this._safetyNetTimeouts.set(mint, safetyTimeout);
  }

  /**
   * Handle trade event
   */
  async _onTrade(tradeData) {
    const mint = tradeData.mint;

    // Check if this is a monitored position (for TP/SL)
    const sellAction = await sellExecutor.processTradeEvent(tradeData);
    if (sellAction) {
      await this._executeSell(sellAction);
      return;
    }

    // Track early buyers — nếu token chưa được track (race: trade tới TRƯỚC newToken event),
    // queue trade lại để replay khi `_onNewToken` xảy ra. Tránh mất các trade đầu tiên
    // (đặc biệt quan trọng cho bundle detection trong slot create).
    const earlyBuyers = this.tokenEarlyBuyers.get(mint);
    if (!earlyBuyers) {
      // Chỉ queue nếu mint chưa từng được analyzed (tránh keep trade của token đã clean up)
      if (!this.analyzedTokens.has(mint)) {
        let pending = this._pendingTrades.get(mint);
        if (!pending) {
          pending = [];
          this._pendingTrades.set(mint, pending);
          // Auto-cleanup sau 60s nếu newToken không bao giờ tới
          setTimeout(() => this._pendingTrades.delete(mint), 60000).unref?.();
        }
        if (pending.length < 30) pending.push(tradeData);
      }
      return;
    }

    // Trade history per mint — phục vụ MEV roundtrip detection.
    // Lưu CẢ buy & sell, giới hạn 200 entry gần nhất để tránh phình memory.
    if (tradeData.trader && tradeData.txType) {
      let hist = this.tokenTradeHistory.get(mint);
      if (!hist) {
        hist = [];
        this.tokenTradeHistory.set(mint, hist);
      }
      hist.push({
        trader: tradeData.trader,
        type: tradeData.txType, // 'buy' | 'sell'
        ts: tradeData.timestamp || Date.now(),
        signature: tradeData.signature || null,
      });
      if (hist.length > 200) hist.splice(0, hist.length - 200);
    }

    if (tradeData.txType === 'buy' && earlyBuyers.length < settings.monitoring.earlyBuyersToMonitor) {
      // Clear safety-net timeout since a real buyer arrived
      const safetyId = this._safetyNetTimeouts.get(mint);
      if (safetyId) { clearTimeout(safetyId); this._safetyNetTimeouts.delete(mint); }

      // Don't add duplicates
      if (!earlyBuyers.some(b => b.address === tradeData.trader)) {
        earlyBuyers.push({
          address: tradeData.trader,
          solAmount: tradeData.solAmount || 0,
          tokenAmount: tradeData.tokenAmount || 0,
          timestamp: tradeData.timestamp,
          signature: tradeData.signature || null,
          slot: tradeData.slot || null,
        });
        logger.info(`👤 Buyer #${earlyBuyers.length}/${settings.monitoring.earlyBuyersToMonitor} for ${this.tokenData.get(mint)?.symbol || shortenAddress(mint)}: ${shortenAddress(tradeData.trader)} (${(tradeData.solAmount || 0).toFixed(4)} SOL)`);
      }

      // Progressive analysis: analyze on FIRST buyer, re-analyze when more buyers arrive
      // processingTokens tracks "currently being analyzed" — cleared after each analysis
      // passedTokens tracks "already confirmed" — no more re-analysis needed
      if (!this.passedTokens.has(mint) && !this.processingTokens.has(mint)) {
        // Count this as a rescan attempt so UI shows correct count
        this._rescanAttempts.set(mint, (this._rescanAttempts.get(mint) || 0) + 1);
        this.processingTokens.add(mint);
        if (!this._analysisQueue) this._analysisQueue = [];
        // Avoid duplicate entries in queue
        if (!this._analysisQueue.includes(mint)) {
          this._analysisQueue.push(mint);
        }
        this._processAnalysisQueue();
      }
    }

    // Accumulate global fee (1% of each trade's SOL amount, same as Axion display)
    const currentFee = this.tokenGlobalFees.get(mint) || 0;
    const tradeFee = (tradeData.solAmount || 0) * 0.01; // PumpFun 1% fee per trade
    this.tokenGlobalFees.set(mint, currentFee + tradeFee);

    // Update token data with latest bonding curve info
    const token = this.tokenData.get(mint);
    if (token) {
      token.vSolInBondingCurve = tradeData.vSolInBondingCurve;
      token.vTokensInBondingCurve = tradeData.vTokensInBondingCurve;
      token.marketCapSol = tradeData.newMarketCapSol;
      token.globalFee = this.tokenGlobalFees.get(mint);

      // Track peak MC để mc_drop_recent rule biết khi token đang dump
      const newMc = Number(tradeData.newMarketCapSol) || 0;
      if (newMc > 0 && (!token.peakMarketCapSol || newMc > token.peakMarketCapSol)) {
        token.peakMarketCapSol = newMc;
        token.peakMarketCapAt = tradeData.timestamp || Date.now();
      }

      // Flag devSold nếu deployer xả token (sớm nhất của rug)
      if (tradeData.txType === 'sell' && tradeData.trader && tradeData.trader === token.deployer && !token.devSold) {
        token.devSold = true;
        token.devSoldAt = tradeData.timestamp || Date.now();
        token.devSoldAmount = tradeData.tokenAmount || 0;
        logger.warn(`🚨 DEV SOLD: ${token.symbol} (${shortenAddress(mint)}) — deployer xả ${(tradeData.solAmount || 0).toFixed(3)} SOL`);
      }

      // Emit live price update to dashboard (throttled: only if token is being tracked)
      if (this.processingTokens.has(mint) || this.passedTokens.has(mint)) {
        webServer.emit('tokenPriceUpdate', {
          mint,
          marketCapSol: tradeData.newMarketCapSol,
          vSolInBondingCurve: tradeData.vSolInBondingCurve,
          globalFee: this.tokenGlobalFees.get(mint),
          txType: tradeData.txType,
          solAmount: tradeData.solAmount,
          buyerCount: (this.tokenEarlyBuyers.get(mint) || []).length,
        });
      }
    }
  }

  /**
   * Process analysis queue - concurrent analysis for faster signals
   * Runs up to MAX_CONCURRENT analyses in parallel to avoid stale data
   */
  async _processAnalysisQueue() {
    if (this._analysisRunning) return;
    if (!this._analysisQueue || this._analysisQueue.length === 0) return;

    this._analysisRunning = true;
    const MAX_CONCURRENT = settings.performance.maxConcurrentAnalysis || 5;

    while (this._analysisQueue.length > 0) {

      // Take a batch of tokens to analyze concurrently
      const batch = this._analysisQueue.splice(0, MAX_CONCURRENT);
      const remaining = this._analysisQueue.length;

      const promises = batch.map(mint => {
        logger.info(`📊 Queue: analyzing ${shortenAddress(mint)} (${remaining} remaining)`);
        return this._runFullAnalysis(mint).catch(err => {
          logger.error(`Analysis failed for ${shortenAddress(mint)}: ${err.message}`);
        });
      });

      await Promise.all(promises);

      // Minimal gap between batches (multiplexed RPC handles rate limits)
      if (this._analysisQueue.length > 0) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    this._analysisRunning = false;
  }

  /**
   * Fetch token supply and top holders from RPC
   * Excludes PumpFun system wallets (bonding curve, migration authority) from holder calculation
   */
  async _fetchTokenHolders(mint, deployer, earlyBuyerWallets = [], bundleWallets = new Set(), tokenTimestamp = Date.now(), jitoBundleWallets = new Set(), currentMarketCapSol = null) {
    try {
      // Adaptive cache TTL: ngắn (2s) khi MC sát ngưỡng pass — tránh false-pass do
      // cache cũ; bình thường (8s) để giảm RPC trong rescan.
      const cfg = settings.holderCache || {};
      const baseTtl = cfg.ttlMs ?? 8000;
      const nearTtl = cfg.nearThresholdTtlMs ?? 2000;
      const nearPct = cfg.nearThresholdPct ?? 0.10;
      const minMc = settings.rules?.minMarketCapSol || 0;
      const maxMc = settings.rules?.maxMarketCapSol || Infinity;
      const isNearThreshold = currentMarketCapSol != null && minMc > 0 && (
        Math.abs(currentMarketCapSol - minMc) / minMc <= nearPct ||
        (Number.isFinite(maxMc) && Math.abs(currentMarketCapSol - maxMc) / maxMc <= nearPct)
      );
      const cacheTtlMs = isNearThreshold ? nearTtl : baseTtl;
      const cached = this.holderStatsCache.get(mint);
      if (cached && Date.now() - cached.timestamp < cacheTtlMs) {
        return cached.data;
      }

      const pubkey = new PublicKey(mint);

      // Derive bonding curve PDA directly from mint
      const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
      const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
      const TOKEN_LEGACY = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

      const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), pubkey.toBuffer()],
        PUMP_PROGRAM
      );

      // Exclude bonding/system/burn owners and the token accounts they control from holder concentration.
      // Sử dụng module config/holder-exclusions làm nguồn duy nhất → dễ maintain.
      const { EXCLUDED_OWNERS, isBurnOwner } = require('../config/holder-exclusions');
      const excludedOwners = new Set([
        bondingCurvePDA.toBase58(),
        ...EXCLUDED_OWNERS,
      ]);
      const excludedTokenAccounts = new Set();

      // Derive bonding curve ATAs for both token programs
      try {
        const [ataLegacy] = PublicKey.findProgramAddressSync(
          [bondingCurvePDA.toBuffer(), TOKEN_LEGACY.toBuffer(), pubkey.toBuffer()],
          ATA_PROGRAM
        );
        excludedTokenAccounts.add(ataLegacy.toBase58());
      } catch (e) { /* ignore */ }
      try {
        const [ata2022] = PublicKey.findProgramAddressSync(
          [bondingCurvePDA.toBuffer(), TOKEN_2022.toBuffer(), pubkey.toBuffer()],
          ATA_PROGRAM
        );
        excludedTokenAccounts.add(ata2022.toBase58());
      } catch (e) { /* ignore */ }

      // Fetch largest accounts, token supply, và mint info (authority + extensions) song song
      const [largestAccounts, tokenSupplyResult, mintAccountInfo] = await Promise.all([
        solana.execute(conn => conn.getTokenLargestAccounts(pubkey), RPC_CATEGORY.METADATA),
        solana.execute(conn => conn.getTokenSupply(pubkey), RPC_CATEGORY.METADATA),
        solana.execute(conn => conn.getParsedAccountInfo(pubkey), RPC_CATEGORY.METADATA),
      ]);

      // Trích xuất mint authority / freeze authority / transferFee extension (Token-2022)
      const mintInfo = (() => {
        const out = {
          mintAuthority: null,
          freezeAuthority: null,
          transferFeeBasisPoints: 0,
          isToken2022: false,
        };
        try {
          const v = mintAccountInfo?.value;
          if (!v?.data?.parsed?.info) return out;
          const programOwner = v.owner?.toBase58?.() || String(v.owner || '');
          out.isToken2022 = programOwner === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
          const info = v.data.parsed.info;
          out.mintAuthority = info.mintAuthority || null;
          out.freezeAuthority = info.freezeAuthority || null;
          if (out.isToken2022 && Array.isArray(info.extensions)) {
            const tfe = info.extensions.find(e => e.extension === 'transferFeeConfig');
            if (tfe) {
              const bp = tfe?.state?.newerTransferFee?.transferFeeBasisPoints
                ?? tfe?.state?.olderTransferFee?.transferFeeBasisPoints
                ?? 0;
              out.transferFeeBasisPoints = parseInt(bp, 10) || 0;
            }
          }
        } catch (err) {
          logger.debug(`Failed to parse mint info for ${shortenAddress(mint)}: ${err.message}`);
        }
        return out;
      })();

      const allAccounts = largestAccounts.value;
      if (!allAccounts || allAccounts.length === 0) {
        logger.debug(`No token accounts found for ${shortenAddress(mint)}`);
        return null;
      }
      // Solana RPC `getTokenLargestAccounts` cap ở 20. Nếu token có > 20 holder thật,
      // các metric concentration/bundle có thể bỏ sót. Log warn để user biết.
      if (allAccounts.length >= 20) {
        logger.debug(`⚠️ ${shortenAddress(mint)}: getTokenLargestAccounts trả 20 records (cap) — có thể bỏ sót holder ngoài top 20.`);
      }

      // === Get ACTUAL decimals and supply from on-chain data ===
      const tokenDecimals = tokenSupplyResult?.value?.decimals ?? allAccounts[0]?.decimals ?? 6;
      const divisor = Math.pow(10, tokenDecimals);

      // Use actual total supply from on-chain
      const supply = tokenSupplyResult?.value?.amount
        ? parseFloat(tokenSupplyResult.value.amount) / divisor
        : 1000000000;

      const normalize = (acc) => {
        if (acc.uiAmount != null) return acc.uiAmount;
        if (acc.uiAmountString) return parseFloat(acc.uiAmountString);
        return parseFloat(acc.amount) / divisor;
      };

      const parsedTokenAccounts = await this._loadTokenAccountOwners(
        allAccounts.map((acc) => ({
          ...acc,
          amount: normalize(acc),
        }))
      );

      const filterRealHolderAccounts = (accounts) => {
        let filteredBondingCurveBalance = 0;
        let burnedAmount = 0;
        let filteredFunctionalCount = 0;
        const filteredAccounts = accounts.filter((acc) => {
          const isBurn = isBurnOwner(acc.owner);
          const isKnownSystem =
            excludedTokenAccounts.has(acc.addr) ||
            this._isLikelyFunctionalOwner(acc.owner, excludedOwners);

          if (isBurn) {
            burnedAmount += acc.amount;
            filteredFunctionalCount++;
            return false;
          }

          if (isKnownSystem) {
            filteredBondingCurveBalance += acc.amount;
            filteredFunctionalCount++;
            return false;
          }

          return true;
        });

        return {
          filteredAccounts,
          filteredBondingCurveBalance,
          burnedAmount,
          filteredFunctionalCount,
        };
      };

      // === Always compute full stats (bundle/early/dev %) — with 16 RPCs we have enough throughput
      // that the old age<60s fast-path was causing retryable rules to fail forever on fresh tokens.

      // === Separate bonding/system/burn from holder accounts ===
      // Program-controlled / PDA-controlled wallets are not shown as real holders.
      // Burn (1nc1...) là token đã đốt → loại khỏi cả tử số VÀ mẫu số.
      let axiomRouteAddress = bondingCurvePDA.toBase58();
      const {
        filteredAccounts: filteredParsedAccounts,
        filteredBondingCurveBalance: bondingCurveBalance,
        burnedAmount,
        filteredFunctionalCount,
      } = filterRealHolderAccounts(parsedTokenAccounts);

      // Circulating supply = total - bonding curve - burned. Đây là mẫu số CHUẨN
      // để tính % concentration (không phải total supply).
      const circulatingSupply = Math.max(0.0001, supply - bondingCurveBalance - burnedAmount);

      logger.debug(`Holder stats for ${shortenAddress(mint)}: decimals=${tokenDecimals}, supply=${supply.toFixed(0)}, bondingCurve=${bondingCurveBalance.toFixed(0)}, burned=${burnedAmount.toFixed(0)}, circulating=${circulatingSupply.toFixed(0)}`);

      // === Sanity check: circulatingSupply must be positive and reasonable ===
      if (circulatingSupply <= 0) {
        logger.warn(`⚠️ Invalid circulatingSupply (${circulatingSupply.toFixed(0)}) for ${shortenAddress(mint)} — supply=${supply}, bondingCurve=${bondingCurveBalance}. Skipping holder stats.`);
        const invalid = {
          supply,
          top10Percent: 0,

          top10OwnersPercent: 0,
          bundleHoldPercent: 0,
          jitoBundleHoldPercent: 0,
          earlyBuyerHoldPercent: 0,
          devHoldPercent: 0,
          circulatingSupply: 0,
          bondingCurveBalance,
          realHolderCount: 0,
          filteredFunctionalCount,
          topHolders: [],
          dataInvalid: true,
        };
        this.holderStatsCache.set(mint, { data: invalid, timestamp: Date.now() });
        return invalid;
      }

      // % concentration mẫu số = circulatingSupply (đã trừ bonding-curve và burned).
      // Đây là semantics CHUẨN — token đang lưu hành thật. % so với total supply
      // (gồm cả bonding-curve) sẽ underestimate khi token còn ở phase early.
      const sortedAccounts = [...filteredParsedAccounts].sort((a, b) => b.amount - a.amount);
      const top10 = sortedAccounts.slice(0, 10);
      const top10Total = top10.reduce((sum, acc) => sum + acc.amount, 0);
      const top10Percent = circulatingSupply > 0 ? (top10Total / circulatingSupply) * 100 : 0;
      // Legacy metric — % so với total supply (giữ cho UI/debug, KHÔNG dùng trong rule)
      const top10TotalSupplyPercent = supply > 0 ? (top10Total / supply) * 100 : 0;

      // Owner-level concentration (gộp các ATA cùng owner) — dùng làm metric phụ.
      const ownerBalances = new Map();
      for (const acc of filteredParsedAccounts) {
        const ownerKey = acc.owner || acc.addr;
        ownerBalances.set(ownerKey, (ownerBalances.get(ownerKey) || 0) + acc.amount);
      }
      const top10OwnersTotal = [...ownerBalances.values()]
        .sort((a, b) => b - a)
        .slice(0, 10)
        .reduce((sum, amount) => sum + amount, 0);
      const top10OwnersPercent = circulatingSupply > 0 ? (top10OwnersTotal / circulatingSupply) * 100 : 0;
      const top10OwnersTotalSupplyPercent = supply > 0 ? (top10OwnersTotal / supply) * 100 : 0;

      // Sanity check: top10 over circulating should never exceed 100% materially.
      if (top10Percent > 100.5) {
        logger.warn(`⚠️ Invalid holder data for ${shortenAddress(mint)} — top10=${top10Percent.toFixed(1)}% of total supply, top10Total=${top10Total.toFixed(0)}, supply=${supply.toFixed(0)}.`);
        const invalid = {
          supply,
          top10Percent: 0,
          top10OwnersPercent: 0,
          bundleHoldPercent: 0,
          jitoBundleHoldPercent: 0,
          earlyBuyerHoldPercent: 0,
          devHoldPercent: 0,
          circulatingSupply,
          bondingCurveBalance,
          realHolderCount: 0,
          filteredFunctionalCount,
          topHolders: [],
          dataInvalid: true,
        };
        this.holderStatsCache.set(mint, { data: invalid, timestamp: Date.now() });
        return invalid;
      }

      // === Early buyer hold percent — current holdings of tracked early buyers ===
      let earlyBuyerHoldPercent = 0;
      let bundleHoldPercent = 0;
      let jitoBundleHoldPercent = 0;
      if (earlyBuyerWallets.length > 0) {
        const allAccountMap = new Map();
        for (const acc of parsedTokenAccounts) {
          allAccountMap.set(acc.addr, acc.amount);
        }

        let earlyBuyerTotal = 0;
        let bundleTotal = 0;
        let jitoBundleTotal = 0;
        for (const w of earlyBuyerWallets) {
          try {
            const walletPubkey = new PublicKey(w.address);
            for (const tokenProgram of [TOKEN_LEGACY, TOKEN_2022]) {
              try {
                const [ata] = PublicKey.findProgramAddressSync(
                  [walletPubkey.toBuffer(), tokenProgram.toBuffer(), pubkey.toBuffer()],
                  ATA_PROGRAM
                );
                const ataAddr = ata.toBase58();
                if (allAccountMap.has(ataAddr)) {
                  const balance = allAccountMap.get(ataAddr);
                  earlyBuyerTotal += balance;
                  if (bundleWallets.has(w.address)) {
                    bundleTotal += balance;
                  }
                  if (jitoBundleWallets.has(w.address)) {
                    jitoBundleTotal += balance;
                  }
                  break;
                }
              } catch (e) { /* ignore */ }
            }
          } catch (e) { /* skip invalid address */ }
        }
        // Mẫu số = circulatingSupply (đã trừ bonding-curve + burned)
        earlyBuyerHoldPercent = Math.min((earlyBuyerTotal / circulatingSupply) * 100, 100);
        bundleHoldPercent = Math.min((bundleTotal / circulatingSupply) * 100, 100);
        jitoBundleHoldPercent = Math.min((jitoBundleTotal / circulatingSupply) * 100, 100);
      }

      // === Dev hold percent — derive deployer's ATA ===
      let devHoldPercent = 0;
      try {
        const deployerPubkey = new PublicKey(deployer);
        const devATAs = new Set();
        try {
          const [devAtaLegacy] = PublicKey.findProgramAddressSync(
            [deployerPubkey.toBuffer(), TOKEN_LEGACY.toBuffer(), pubkey.toBuffer()],
            ATA_PROGRAM
          );
          devATAs.add(devAtaLegacy.toBase58());
        } catch (e) { /* ignore */ }
        try {
          const [devAta2022] = PublicKey.findProgramAddressSync(
            [deployerPubkey.toBuffer(), TOKEN_2022.toBuffer(), pubkey.toBuffer()],
            ATA_PROGRAM
          );
          devATAs.add(devAta2022.toBase58());
        } catch (e) { /* ignore */ }

        const devAccount = parsedTokenAccounts.find(acc => {
          return devATAs.has(acc.addr);
        });
        if (devAccount) {
          devHoldPercent = Math.min((devAccount.amount / circulatingSupply) * 100, 100);
        }
      } catch (e) {
        logger.debug(`Could not derive dev ATA for ${shortenAddress(deployer)}: ${e.message}`);
      }

      const result = {
        supply,
        top10Percent,
        top10TotalSupplyPercent,
        top10CirculatingPercent: top10Percent, // alias: % giờ là circulating-based
        top10OwnersPercent,
        top10OwnersTotalSupplyPercent,
        top10OwnersCirculatingPercent: top10OwnersPercent,
        bundleHoldPercent,
        jitoBundleHoldPercent,
        earlyBuyerHoldPercent,
        devHoldPercent,
        circulatingSupply,
        bondingCurveBalance,
        burnedAmount,
        mintInfo,
        realHolderCount: filteredParsedAccounts.length,
        filteredFunctionalCount,
        axiomRouteAddress,
        topHolders: top10.map(t => {
          const addr = t.addr || '';
          const ownerAddr = t.owner || '';
          return {
            address: addr,
            owner: ownerAddr,
            // % của holder cá nhân — dùng circulating làm mẫu số cho thống nhất
            percent: Math.min((t.amount / circulatingSupply) * 100, 100),
            isDev: ownerAddr === deployer || addr === deployer,
            isBundle: bundleWallets ? (bundleWallets.has(ownerAddr) || bundleWallets.has(addr)) : false,
            isJitoBundle: jitoBundleWallets ? (jitoBundleWallets.has(ownerAddr) || jitoBundleWallets.has(addr)) : false,
          };
        }),
      };
      this.holderStatsCache.set(mint, { data: result, timestamp: Date.now() });
      return result;
    } catch (err) {
      if (err.message && err.message.includes('not a Token mint')) {
        logger.debug(`Token ${shortenAddress(mint)} not yet minted on RPC, skipping holder fetch.`);
      } else {
        logger.warn(`Failed to fetch holder data: ${err.message}`);
      }
      const cached = this.holderStatsCache.get(mint);
      if (cached) return cached.data;
      return null;
    }
  }

  /**
   * Subscribe trực tiếp logs PumpFun program → pre-cache (signature, slot).
   * Mục đích: giảm RPC `getParsedTransaction` chỉ-để-lấy-slot trong bundle detect.
   * Commitment 'processed' → ~400ms latency. Dùng connection trong category DETECTION.
   */
  _startDirectLogsSubscription() {
    const cfg = settings.directLogs || {};
    if (cfg.enabled === false) {
      logger.info('Direct logs subscription disabled (DIRECT_LOGS_ENABLED=false)');
      return;
    }
    try {
      const conn = solana.getCategoryConnection(RPC_CATEGORY.DETECTION);
      if (!conn) {
        logger.warn('Direct logs: không có DETECTION connection');
        return;
      }
      const PUMP_PROGRAM = new PublicKey(settings.pumpfun.programId);
      const commitment = cfg.commitment || 'processed';

      this._directLogsSubId = conn.onLogs(
        PUMP_PROGRAM,
        (logs, ctx) => {
          if (!logs?.signature || !ctx?.slot) return;
          this._slotCache.set(logs.signature, { slot: ctx.slot, ts: Date.now() });
        },
        commitment,
      );
      logger.info(`📡 Direct logs subscribed (PumpFun, ${commitment}) — slot pre-cache active`);

      // GC slotCache mỗi 60s
      const ttl = cfg.cacheTtlMs ?? (5 * 60 * 1000);
      this._slotCacheGcTimer = setInterval(() => {
        const cutoff = Date.now() - ttl;
        for (const [sig, entry] of this._slotCache.entries()) {
          if (entry.ts < cutoff) this._slotCache.delete(sig);
        }
      }, 60 * 1000);
      this._slotCacheGcTimer.unref?.();
    } catch (err) {
      logger.warn(`Direct logs subscription failed: ${err.message}`);
    }
  }

  /**
   * Two-tier bundle detection:
   *   coLaunchWallets    = same-slot ≥ 4 ví (loose — có thể là sniper bot ngẫu nhiên)
   *   jitoBundleWallets  = subset có ít nhất 1 tx trong slot đó chuyển SOL tới Jito tip
   *                        account → đây là Jito Bundle THẬT do searcher submit
   *
   * Tách 2 metric vì same-slot ≥ 4 KHÔNG đồng nghĩa với Jito Bundle (4 sniper bot
   * khác nhau trùng slot là chuyện thường). Rule downstream nên dùng jitoBundle...
   * cho ngưỡng siết, dùng coLaunch... cho ngưỡng lỏng.
   */
  async _detectBundleWallets(earlyBuyerTrades) {
    const empty = { coLaunchWallets: new Set(), jitoBundleWallets: new Set() };
    if (!earlyBuyerTrades || earlyBuyerTrades.length < 4) return empty;

    const { hasJitoTipTransfer } = require('../config/jito.constants');

    // Step 1: Resolve slot + parsed tx (để check tip Jito) cho từng trade.
    // Slot có thể đã pre-cache từ direct logsSubscribe → tiết kiệm RPC.
    const tradesWithMeta = await Promise.all(earlyBuyerTrades.map(async (trade) => {
      if (!trade.signature) return { ...trade, slot: trade.slot || null, parsed: null };
      const cachedSlot = this._slotCache.get(trade.signature)?.slot;
      try {
        const parsed = await solana.executeRace(conn =>
          conn.getParsedTransaction(trade.signature, { maxSupportedTransactionVersion: 0 })
        );
        return {
          ...trade,
          slot: trade.slot || parsed?.slot || cachedSlot || null,
          parsed,
        };
      } catch (err) {
        logger.debug(`Failed to fetch tx for ${trade.signature}: ${err.message}`);
        // Fallback: dùng slot từ cache nếu có (parsed = null → không check được tip)
        return { ...trade, slot: trade.slot || cachedSlot || null, parsed: null };
      }
    }));

    // Step 2: Build slot → traders map, identify co-launch slots (>= 4 ví)
    const slotMap = new Map();
    for (const trade of tradesWithMeta) {
      if (!trade.slot || !trade.trader) continue;
      if (!slotMap.has(trade.slot)) slotMap.set(trade.slot, []);
      slotMap.get(trade.slot).push(trade);
    }

    const coLaunchSlots = new Set();
    const jitoConfirmedSlots = new Set();
    for (const [slot, trades] of slotMap.entries()) {
      const uniqueTraders = new Set(trades.map(t => t.trader));
      if (uniqueTraders.size < 4) continue;
      coLaunchSlots.add(slot);
      // Slot trở thành "jito-confirmed" nếu BẤT KỲ tx nào trong slot có tip
      if (trades.some(t => hasJitoTipTransfer(t.parsed))) {
        jitoConfirmedSlots.add(slot);
      }
    }

    if (coLaunchSlots.size === 0) return empty;

    // Step 3: Pattern filter — build per-trader trade list sorted by slot
    const traderTrades = new Map();
    for (const trade of tradesWithMeta) {
      if (!trade.trader || !trade.slot) continue;
      if (!traderTrades.has(trade.trader)) traderTrades.set(trade.trader, []);
      traderTrades.get(trade.trader).push(trade);
    }
    for (const trades of traderTrades.values()) {
      trades.sort((a, b) => (a.slot || 0) - (b.slot || 0));
    }

    const passesPatternFilter = (trader, slotSet) => {
      const trades = traderTrades.get(trader) || [];
      const idx = trades.findIndex(t => slotSet.has(t.slot));
      if (idx === -1) return false;
      const nextTrade = trades[idx + 1];
      if (!nextTrade) return true; // không có data tiếp → giữ (conservative)
      return slotSet.has(nextTrade.slot); // next trade cũng phải trong bundle slot
    };

    const coLaunchCandidates = new Set();
    for (const slot of coLaunchSlots) {
      for (const t of slotMap.get(slot)) coLaunchCandidates.add(t.trader);
    }

    const coLaunchWallets = new Set();
    const jitoBundleWallets = new Set();
    for (const trader of coLaunchCandidates) {
      if (!passesPatternFilter(trader, coLaunchSlots)) continue;
      coLaunchWallets.add(trader);
      // Ví thuộc slot jito-confirmed → vào jitoBundleWallets
      const trades = traderTrades.get(trader) || [];
      if (trades.some(t => jitoConfirmedSlots.has(t.slot))) {
        jitoBundleWallets.add(trader);
      }
    }

    logger.debug(`Bundle detection: ${coLaunchCandidates.size} co-launch candidates → ${coLaunchWallets.size} after filter (${coLaunchSlots.size} slots) | ${jitoBundleWallets.size} jito-confirmed (${jitoConfirmedSlots.size} slots)`);
    return { coLaunchWallets, jitoBundleWallets };
  }

  /**
   * Full analysis pipeline: analyze early buyers → check rules → decide buy
   */
  async _runFullAnalysis(mint) {
    const tokenData = this.tokenData.get(mint);
    const earlyBuyers = this.tokenEarlyBuyers.get(mint);

    if (!tokenData) {
      this.processingTokens.delete(mint);
      return;
    }

    // For automated entry, we MUST have at least 1 early buyer.
    // For manual refreshes (isManual), we allow proceeding to check current stats.
    if (!tokenData.isManual && (!earlyBuyers || earlyBuyers.length === 0)) {
      this.processingTokens.delete(mint);

      // Keep UI in sync on rescans even when no buyers arrived yet.
      // Without this emit, the feed card's "Lần N" counter stays at the last
      // value (usually 1) even though the rescan scheduler keeps firing. The
      // user sees "đang chờ vài phút" and thinks the bot stopped — emitting
      // a lightweight waiting-for-buyers result every tick solves that.
      try {
        const ageMinutes = (Date.now() - tokenData.timestamp) / 60000;
        const maxAge = this._getMaxAgeMinutes();
        const isAgedOut = ageMinutes >= maxAge;
        const required = settings.monitoring.earlyBuyersToMonitor;
        const attempt = Math.max(
          tracker.getScanCount(mint),
          (this._rescanAttempts.get(mint) || 0) + 1
        );

        webServer.emit('analysisResult', {
          tokenData: { ...tokenData, analysisTimestamp: Date.now() },
          ruleResult: {
            shouldBuy: false,
            summary: `Không đủ ví mua: 0/${required} sau ${ageMinutes.toFixed(1)} phút.`,
            results: [{
              ruleId: 'preliminary_buyers',
              ruleName: 'Ví mua sớm',
              ruleType: 'PRE-SCAN',
              passed: false,
              reason: `Chưa có ví mua nào (0/${required}) — đang chờ giao dịch đầu tiên.`,
            }],
            onlyRetryableFailed: !isAgedOut,
          },
          earlyBuyers: [],
          earlyBuyerTrades: [],
          globalFee: this.tokenGlobalFees.get(mint) || 0,
          solPrice: priceService.solPrice || 150,
          retryCount: attempt,
          isFinal: isAgedOut,
        });
      } catch (emitErr) {
        logger.debug(`Waiting-state emit failed for ${shortenAddress(mint)}: ${emitErr.message}`);
      }

      return;
    }

    const buyers = earlyBuyers || [];
    const buyerCountAtStart = buyers.length; // Snapshot to detect new arrivals during analysis
    const requiredBuyers = settings.monitoring.minBuyersToPass;
    const hasEnoughBuyers = buyers.length >= requiredBuyers;

    // Extract addresses and trade data from early buyer objects
    const buyerAddresses = buyers.map(b => b.address);
    const earlyBuyerTrades = buyers.map(b => ({
      trader: b.address,
      solAmount: b.solAmount,
      tokenAmount: b.tokenAmount || 0,
      signature: b.signature || null,
      slot: b.slot || null,
    }));

    logger.info(`🔍 Running full analysis for ${tokenData.symbol} (${shortenAddress(mint)}) [${buyers.length}/${requiredBuyers} buyers]`);

    try {
      // Derive the canonical Pump bonding-curve PDA once and keep Axiom links pinned to it
      // while the token is still trading on Pump. This prevents unrelated off-curve owners
      // from being misused as the route address.
      let expectedAxiomRouteAddress = null;
      try {
        const mintPubkey = new PublicKey(mint);
        const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
        const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
          [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
          PUMP_PROGRAM
        );
        expectedAxiomRouteAddress = bondingCurvePDA.toBase58();
        if (!tokenData.axiomRouteAddress || tokenData.axiomRouteAddress === tokenData.mint) {
          tokenData.axiomRouteAddress = expectedAxiomRouteAddress;
        }
      } catch (e) { /* ignore - fallback to mint */ }

      // === PARALLEL ANALYSIS: Run independent RPC calls concurrently ===
      // Cache dev analysis to avoid redundant RPC calls on re-scans
      const [devAnalysis, buyerAnalyses, bundleDetect] = await Promise.all([
        // 1. Dev analysis (2-3 RPC calls) - ~2s, cached after first run
        tokenData._devAnalysis || devAnalyzer.analyzeDeployer(tokenData.deployer).then(result => {
          tokenData._devAnalysis = result; // Cache for subsequent re-scans
          return result;
        }),
        // 2. Wallet analysis (parallel batches) - ~12s
        // Pass deployer để peel-chain trace dừng khi gặp deployer (insider signal)
        walletAnalyzer.analyzeEarlyBuyers(buyerAddresses, tokenData.deployer),
        // 3. Bundle wallet detection — trả 2 set: coLaunch (same-slot) và jitoBundle (có tip)
        this._detectBundleWallets(earlyBuyerTrades),
      ]);
      const coLaunchWallets = bundleDetect?.coLaunchWallets || new Set();
      const jitoBundleWallets = bundleDetect?.jitoBundleWallets || new Set();
      // Backwards-compat: bundleWallets = coLaunchWallets (rule cũ vẫn xài tên này)
      const bundleWallets = coLaunchWallets;

      // Merge trade amounts into buyerAnalyses so the frontend can display them accurately
      if (buyerAnalyses && earlyBuyerTrades) {
        for (const analysis of buyerAnalyses) {
          const buyerTrade = earlyBuyerTrades.find(b => b.trader === analysis.address);
          if (buyerTrade) {
            analysis.solAmount = buyerTrade.solAmount || 0;
            analysis.tokenAmount = buyerTrade.tokenAmount || 0;
          }
        }
      }

      // 4. Holder stats after we know bundle wallets
      const holderStats = await this._fetchTokenHolders(
        mint,
        tokenData.deployer,
        earlyBuyers,
        bundleWallets,
        tokenData.timestamp,
        jitoBundleWallets,
        tokenData.marketCapSol
      );
      // Only accept the canonical Pump bonding-curve PDA from holder analysis.
      if (
        holderStats?.axiomRouteAddress &&
        holderStats.axiomRouteAddress !== tokenData.mint &&
        (!expectedAxiomRouteAddress || holderStats.axiomRouteAddress === expectedAxiomRouteAddress)
      ) {
        tokenData.axiomRouteAddress = holderStats.axiomRouteAddress;
      }

      // 5. Token score — runs after devAnalysis + buyerAnalyses so it can use their data
      const tokenScore = await tokenScorer.scoreToken(tokenData, devAnalysis, buyerAnalyses);

      // 6. Cluster detection (uses cached wallet data from step 3, no extra RPC)
      const clusterAnalysis = walletAnalyzer.detectClusterFromCache(buyerAddresses);

      // 6b. MEV / bot detection: kết hợp trade history (roundtrip) + heuristic + blacklist.
      const botDetector = require('../analyzers/bot-detector');
      const { mevWallets, reasons: mevReasons } = botDetector.detectBots({
        tradeHistory: this.tokenTradeHistory.get(mint) || [],
        earlyBuyerAnalyses: buyerAnalyses,
      });

      // 7. Calculate bonding curve progress (dynamic threshold qua env, default 85 SOL)
      const migrateThreshold = settings.pumpfun?.migrateThresholdSol || 85;
      let bondingCurveProgress = tokenData.vSolInBondingCurve
        ? (tokenData.vSolInBondingCurve / migrateThreshold) * 100
        : 0;

      // === Synchronize Market Cap calculation with Migration Check ===
      const solPrice = await priceService.getSolPrice() || 150;
      
      // DexScreener fetch: near-migration OR age>60s (parallel path keeps main pipeline fast,
      // early fetch catches migrated tokens that otherwise sit idle for 10+ minutes).
      if (bondingCurveProgress > 80 || (Date.now() - tokenData.timestamp > 60000)) {
        try {
          const pairs = await priceService.getTokensData([mint]);
          const bestPair = priceService.selectBestPairForMint(pairs, mint);
          if (bestPair) {
            const dexMcapUsd = parseFloat(bestPair.marketCap || bestPair.fdv || 0);
            if (dexMcapUsd > 0) {
              tokenData.marketCapSol = dexMcapUsd / solPrice;
              tokenData.marketCapUsd = dexMcapUsd;
              tokenData.isMigrated = true;
              bondingCurveProgress = 100;
              logger.debug(`Price synced from DexScreener for ${tokenData.symbol}: $${dexMcapUsd.toFixed(0)}`);
            }
          }
        } catch (err) { /* fallback to bonding curve calc */ }
      }

      const totalSupply = holderStats?.supply || 1000000000;
      const circulatingSupply = holderStats?.circulatingSupply || totalSupply;
      const tokenPriceSol = totalSupply > 0 ? (tokenData.marketCapSol || 0) / totalSupply : 0;
      
      tokenData.circulatingMcapSol = tokenPriceSol * circulatingSupply;
      tokenData.circulatingMcapUsd = tokenData.circulatingMcapSol * solPrice;
      tokenData.marketCapUsd = tokenData.marketCapUsd || ((tokenData.marketCapSol || 0) * solPrice);
      
      // baseline for PnL tracking - prefer FDV (full mcap) to match PumpFun/DexScreener displays
      const launchMcapUsd = tokenData.marketCapUsd || tokenData.circulatingMcapUsd || 0;
      tokenData.launchMcapUsd = launchMcapUsd;

      // 8. Run rule engine
      const ruleResult = ruleEngine.evaluate({
        tokenData,
        earlyBuyers: buyerAnalyses,
        earlyBuyerTrades,
        clusterAnalysis,
        devAnalysis,
        tokenScore,
        bondingCurveProgress,
        holderStats,
        bundleWallets,
        coLaunchWallets,
        jitoBundleWallets,
        mevWallets,
        mevReasons,
        tokenTradeHistory: this.tokenTradeHistory.get(mint) || [],
        settings,
      });

      // Log detailed rule results
      logger.info(`📋 Rules for ${tokenData.symbol} (${shortenAddress(mint)}):`);
      for (const r of ruleResult.results) {
        const icon = r.passed ? '✅' : '❌';
        logger.info(`  ${icon} [${r.ruleType}] ${r.ruleName}: ${r.reason}`);
      }
      logger.info(`  → ${ruleResult.summary}`);

      // Analysis chạy được tới rule engine = thành công ở tầng pipeline
      this._analysisHealth.ok++;

      // Fast alert: dashboard-only preview tại buyer #1 nếu các rule critical (mint
      // renounce, transfer fee, dev risk, mcap) đều pass. Không telegram, không
      // auto-buy — chỉ giảm latency cho user thấy "candidate" sớm hơn 5-15s.
      const fastAlertCfg = settings.fastAlert || {};
      if (fastAlertCfg.enabled && buyers.length === 1 && !tokenData._fastAlertSent) {
        const fastRuleIds = new Set(fastAlertCfg.rules || []);
        const fastResults = ruleResult.results.filter(r => fastRuleIds.has(r.ruleId));
        const fastPassed = fastResults.length > 0 && fastResults.every(r => r.passed);
        if (fastPassed) {
          tokenData._fastAlertSent = true;
          webServer.emit('fastSignal', {
            tokenData: { ...tokenData, analysisTimestamp: Date.now() },
            fastResults,
            buyerCount: buyers.length,
            note: 'Critical rules pass tại buyer #1 — chờ full analysis confirm',
          });
        }
      }

      // Emit to real-time dashboard (comprehensive data for professional view)
      // Preserve original token timestamp for accurate age display
      webServer.emit('analysisResult', {
        tokenData: { ...tokenData, bondingCurveProgress, analysisTimestamp: Date.now() },
        ruleResult,
        devAnalysis,
        tokenScore,
        holderStats,
        clusterAnalysis,
        earlyBuyers: buyerAnalyses,
        earlyBuyerTrades,
        globalFee: this.tokenGlobalFees.get(mint) || 0,
        solPrice, // Include current solPrice for frontend sync
        retryCount: Math.max(
          tracker.getScanCount(mint) + 1,
          (this._rescanAttempts.get(mint) || 0) + 1
        ),
        isFinal: (ruleResult.shouldBuy && hasEnoughBuyers) || ((Date.now() - tokenData.timestamp) / 60000 >= this._getMaxAgeMinutes()),
      });

      // 8. Record scan
      tracker.recordScan({
        mint,
        tokenName: tokenData.name,
        tokenSymbol: tokenData.symbol,
        deployer: tokenData.deployer,
        devRiskScore: devAnalysis?.riskScore,
        tokenScore: tokenScore.totalScore,
        tokenScoreDetails: tokenScore,
        clusterDetected: clusterAnalysis?.isLikelyCluster,
        ruleResult, // Store full object for detailed history logic
        devAnalysis,
        holderStats,
        clusterAnalysis,
        earlyBuyers: buyerAnalyses,
        earlyBuyerTrades,
        actionTaken: ruleResult.shouldBuy ? 'ELIGIBLE' : 'BLOCKED',
        isFinal: (ruleResult.shouldBuy && hasEnoughBuyers) || ((Date.now() - tokenData.timestamp) / 60000 >= this._getMaxAgeMinutes()),
        timestamp: Date.now(),
      });
      this.analyzedTokens.add(mint);

      // 9. If passed all rules AND we have enough buyers for a confident decision
      if (ruleResult.shouldBuy && hasEnoughBuyers) {
        this._clearPendingRecheck(mint);
        // Prevent duplicate alerts
        if (this.passedTokens.has(mint)) {
          logger.debug(`Token ${tokenData.symbol} already passed and alerted. Skipping duplicate alert.`);
          return;
        }

        // === ANTI-TOP-BUY GUARD ===
        // Data: 46% pass có ATH = launch_mcap (pump-then-dump tại đỉnh).
        // Đợi N ms để xem giá có dump không; nếu dump >X% thì skip alert/buy.
        const guardSkip = await this._antiTopBuyGuard(mint, tokenData);
        if (guardSkip) {
          this.passedTokens.add(mint); // mark để không retry, nhưng KHÔNG ghi passed_tokens
          this._clearPendingRecheck(mint);
          return;
        }

        this.passedTokens.add(mint);

        // === Refresh mcap right before sending alert (tokenData.marketCapSol may have been updated by trades) ===
        const freshMarketCapSol = tokenData.marketCapSol || 0;
        const freshTokenPriceSol = totalSupply > 0 ? freshMarketCapSol / totalSupply : 0;
        tokenData.circulatingMcapSol = freshTokenPriceSol * circulatingSupply;
        tokenData.circulatingMcapUsd = tokenData.circulatingMcapSol * solPrice;
        if (!tokenData.isMigrated) {
          tokenData.marketCapUsd = freshMarketCapSol * solPrice;
        }
        // Use full mcap (FDV) as baseline — matches PumpFun/DexScreener display
        const freshLaunchMcapUsd = tokenData.marketCapUsd || tokenData.circulatingMcapUsd || 0;
        tokenData.launchMcapUsd = freshLaunchMcapUsd;

        // Record for ATH tracking (single call, no duplicate)
        tracker.recordPassedToken({
          mint,
          symbol: tokenData.symbol,
          launchMcapUsd: freshLaunchMcapUsd,
          launchMcapSol: freshMarketCapSol, // Fixed SOL MC at pass
          highestMcapUsd: freshLaunchMcapUsd,
          highestMcapSol: freshMarketCapSol,
          highestMcapTimestamp: Date.now(),
          timestamp: Date.now()
        });

        // 10. Execute buy FIRST — speed is critical, every millisecond counts
        await this._executeBuy(mint, tokenData, ruleResult);

        // After buy attempt, send notifications (non-blocking)
        tokenData.solPrice = solPrice;
        telegram.sendNewTokenAlert(tokenData, {
          ruleResult,
          devAnalysis,
          clusterAnalysis,
          tokenScore,
          holderStats,
          solPrice
        }).then(() => logger.info(`✅ Telegram alert sent for ${tokenData.symbol}`)).catch(e => logger.error(`Telegram alert failed: ${e.message}`));

        // Broadcast updated passed tokens list to all connected web clients
        webServer.emit('passedTokensUpdate', tracker.getPassedTokens24h());
      } else if (ruleResult.shouldBuy && !hasEnoughBuyers) {
        this.processingTokens.delete(mint); // Allow re-queue from timer and new buyer events
        this._scheduleRecheck(
          mint,
          5000,
          `đã pass rules nhưng mới có ${buyers.length}/${requiredBuyers} buyers`
        );
      } else {
        const ageMinutes = (Date.now() - tokenData.timestamp) / 60000;
        const maxAge = this._getMaxAgeMinutes();
        this.processingTokens.delete(mint);

        // Re-scan liên tục mỗi 8s cho tới khi hết tuổi — dữ liệu token thay đổi liên tục
        if (!this.passedTokens.has(mint) && ageMinutes < maxAge) {
          this._scheduleRecheck(
            mint,
            5000,
            ruleResult.onlyRetryableFailed
              ? 'chỉ còn điều kiện retryable chưa đạt — quét lại với dữ liệu mới'
              : 'chưa đạt điều kiện — quét lại với dữ liệu mới mỗi 5s'
          );
        } else {
          this._clearPendingRecheck(mint);
          logger.info(`❌ ${tokenData.symbol}: ${ruleResult.summary} (Ngưng quét, tuổi: ${ageMinutes.toFixed(1)}m)`);
          
          // Emit one last result marked as final if it's the one that hit the age limit
          webServer.emit('analysisResult', {
            tokenData: { ...tokenData, bondingCurveProgress, analysisTimestamp: Date.now() },
            ruleResult,
            devAnalysis,
            tokenScore,
            holderStats,
            clusterAnalysis,
            earlyBuyers: buyerAnalyses,
            earlyBuyerTrades,
            globalFee: this.tokenGlobalFees.get(mint) || 0,
            solPrice,
            retryCount: Math.max(
              tracker.getScanCount(mint),
              (this._rescanAttempts.get(mint) || 0) + 1
            ),
            isFinal: true,
          });
        }
      }
    } catch (err) {
      this._analysisHealth.fail++;
      logger.error(`Full analysis failed for ${shortenAddress(mint)}: ${err.message}`);
      // Persist the error to DB so the token is never silently lost
      try {
        tracker.recordScan({
          mint,
          tokenName: tokenData.name,
          tokenSymbol: tokenData.symbol,
          deployer: tokenData.deployer,
          ruleResult: {
            shouldBuy: false,
            summary: `❌ Analysis error: ${err.message}`,
            results: [{ ruleId: 'analysis_error', ruleName: 'Analysis Pipeline', ruleType: 'BLOCK', passed: false, reason: err.message }],
          },
          actionTaken: 'BLOCKED',
          timestamp: Date.now(),
        });
      } catch (dbErr) {
        logger.error(`Failed to persist analysis error for ${shortenAddress(mint)}: ${dbErr.message}`);
      }
      this.processingTokens.delete(mint);
      this._scheduleRecheck(mint, 5000, 'gặp lỗi phân tích tạm thời');
    } finally {
      this.processingTokens.delete(mint);

      // === FIX RACE CONDITION: Check if more buyers arrived during analysis ===
      const currentBuyers = this.tokenEarlyBuyers.get(mint);
      if (
        currentBuyers &&
        currentBuyers.length > buyerCountAtStart &&
        !this.passedTokens.has(mint) &&
        this.tokenData.has(mint)
      ) {
        const ageMinutes = (Date.now() - (this.tokenData.get(mint)?.timestamp || Date.now())) / 60000;
        const maxAge = this._getMaxAgeMinutes();
        if (ageMinutes < maxAge) {
          logger.info(`🔄 ${tokenData.symbol}: ${currentBuyers.length - buyerCountAtStart} buyer(s) mới đến trong lúc phân tích (${buyerCountAtStart}→${currentBuyers.length}). Re-queue ngay.`);
          this._rescanAttempts.set(mint, (this._rescanAttempts.get(mint) || 0) + 1);
          this.processingTokens.add(mint);
          if (!this._analysisQueue) this._analysisQueue = [];
          if (!this._analysisQueue.includes(mint)) {
            this._analysisQueue.push(mint);
          }
          this._processAnalysisQueue();
        }
      }

      // Cleanup old token data (keep last 100)
      this._cleanup();
    }
  }

  /**
   * Get max age from listing_age_limit rule (hoặc default 5 phút)
   */
  _getMaxAgeMinutes() {
    const rule = ruleEngine.rules.get('listing_age_limit');
    return (rule && rule.enabled) ? (rule.maxMinutes || 5) : 5;
  }

  /**
   * Anti-top-buy guard
   * Đợi delayMs sau khi pass rules. Nếu marketCapSol giảm > maxDriftPercent
   * trong khoảng đợi → token đang dump tại đỉnh → skip alert/buy.
   *
   * Returns: true nếu nên SKIP, false nếu OK tiếp tục.
   *
   * Lý do: data cho thấy 46% pass có ATH ngay tại pass timestamp,
   * tức là token pump nhân tạo rồi dump trong vài giây sau pass.
   * Đợi 5s và check drift loại được phần lớn nhóm này.
   */
  async _antiTopBuyGuard(mint, tokenData) {
    const cfg = settings.antiTopBuy || {};
    if (!cfg.enabled) return false;
    const delayMs = Math.max(0, cfg.delayMs || 0);
    if (delayMs === 0) return false;

    const mcAtPass = tokenData.marketCapSol || 0;
    if (mcAtPass <= 0) return false; // không có baseline để so sánh

    const maxDrift = (cfg.maxDriftPercent ?? 8) / 100;

    logger.debug(`🛡️ Anti-top-buy guard: chờ ${delayMs}ms cho ${tokenData.symbol} (MC ${mcAtPass.toFixed(1)} SOL)...`);
    await new Promise((r) => setTimeout(r, delayMs));

    const fresh = this.tokenData.get(mint);
    const mcNow = fresh?.marketCapSol || 0;
    if (mcNow <= 0) {
      // Không nhận được trade event nào trong delay — không có tín hiệu dump.
      // Chấp nhận tiếp tục.
      return false;
    }

    const drift = (mcAtPass - mcNow) / mcAtPass; // > 0 nghĩa là MC giảm
    if (drift > maxDrift) {
      const dropPct = (drift * 100).toFixed(1);
      logger.info(`⏭ Skipped ${tokenData.symbol}: MC dropped ${dropPct}% trong ${delayMs}ms sau pass — likely top buy (${mcAtPass.toFixed(1)}→${mcNow.toFixed(1)} SOL)`);

      // Ghi scan note để dashboard hiển thị, nhưng KHÔNG ghi passed_tokens
      try {
        tracker.recordScan({
          mint,
          tokenName: tokenData.name,
          tokenSymbol: tokenData.symbol,
          deployer: tokenData.deployer,
          ruleResult: {
            shouldBuy: false,
            summary: `🛡️ Anti-top-buy: MC giảm ${dropPct}% trong ${delayMs}ms sau pass`,
            results: [{
              ruleId: 'anti_top_buy_guard',
              ruleName: 'Anti-Top-Buy Guard',
              ruleType: 'POST-PASS',
              passed: false,
              reason: `MC ${mcAtPass.toFixed(1)} → ${mcNow.toFixed(1)} SOL (-${dropPct}%) trong ${delayMs}ms`,
            }],
          },
          actionTaken: 'BLOCKED',
          isFinal: true,
          timestamp: Date.now(),
        });

        webServer.emit('analysisResult', {
          tokenData: { ...tokenData, marketCapSol: mcNow, analysisTimestamp: Date.now() },
          ruleResult: {
            shouldBuy: false,
            summary: `🛡️ Anti-top-buy skip: MC -${dropPct}% trong ${delayMs}ms`,
            results: [{
              ruleId: 'anti_top_buy_guard',
              ruleName: 'Anti-Top-Buy Guard',
              ruleType: 'POST-PASS',
              passed: false,
              reason: `MC ${mcAtPass.toFixed(1)} → ${mcNow.toFixed(1)} SOL (-${dropPct}%)`,
            }],
          },
          isFinal: true,
        });
      } catch (err) {
        logger.debug(`Anti-top-buy emit/record failed: ${err.message}`);
      }

      return true;
    }

    logger.debug(`✅ Anti-top-buy guard pass: ${tokenData.symbol} MC drift ${(drift * 100).toFixed(1)}% (<= ${(maxDrift * 100).toFixed(0)}%)`);
    return false;
  }

  /**
   * Start 1-minute timer to check for timed-out tokens
   */
  _startCleanupTimer() {
    setInterval(() => {
      this._cleanupOldTokens();
    }, 60000); // Check every minute

    // Guard timer: every 15s, ensure every not-yet-final token under maxAge
    // has either a pending recheck, is currently processing, or is queued.
    // Recovers from any dropped/lost setTimeout (e.g., process was busy).
    setInterval(() => {
      try {
        this._guardRechecks();
      } catch (err) {
        logger.debug(`Guard recheck sweep failed: ${err.message}`);
      }
    }, 15000);
  }

  /**
   * BUG RS3 guard: sweep tokenData and reschedule any token that is
   * - still under maxAge
   * - not yet passed / not in a final state
   * - has no pending recheck, not processing, not queued
   * This prevents tokens from getting stuck with only 1 scan when a
   * scheduled recheck was silently dropped.
   */
  _guardRechecks() {
    if (this.isPaused) return;
    const maxAge = this._getMaxAgeMinutes();
    const now = Date.now();

    for (const [mint, token] of this.tokenData.entries()) {
      if (this.passedTokens.has(mint)) continue;
      if (this.processingTokens.has(mint)) continue;
      if (this.pendingRechecks.has(mint)) continue;
      if (this._analysisQueue && this._analysisQueue.includes(mint)) continue;

      const ageMinutes = (now - token.timestamp) / 60000;
      if (ageMinutes >= maxAge) continue; // aged out — leave to cleanup

      // Only rescue tokens that already produced at least one analysis;
      // brand-new tokens are driven by their own init path.
      if (!this.analyzedTokens.has(mint)) continue;

      logger.warn(`🛟 Guard: ${token.symbol || shortenAddress(mint)} thiếu re-check (${ageMinutes.toFixed(1)}m/${maxAge}m) — reschedule.`);
      this._scheduleRecheck(mint, this._recheckInterval, 'guard timer phát hiện thiếu re-check');
    }
  }

  /**
   * Identify tokens that failed to get 5 buyers within the window
   */
  _cleanupOldTokens() {
    const now = Date.now();
    const durationMs = (settings.monitoring.monitoringDuration || 300) * 1000;

    for (const [mint, token] of this.tokenData.entries()) {
      // If token is > X mins old and hasn't been analyzed yet
      if (now - token.timestamp > durationMs && !this.analyzedTokens.has(mint) && !this.processingTokens.has(mint)) {
        const buyers = this.tokenEarlyBuyers.get(mint) || [];

        logger.info(`⏹️ Timeout: ${token.symbol} (${shortenAddress(mint)}) only got ${buyers.length}/${settings.monitoring.earlyBuyersToMonitor} buyers. Recording FAIL.`);

        const finalRuleResult = {
          shouldBuy: false,
          summary: `Bị loại: Không đủ ${settings.monitoring.earlyBuyersToMonitor} ví mua sớm trong 5 phút.`,
          results: [
            { ruleId: 'preliminary_buyers', ruleName: 'Ví mua sớm', ruleType: 'PRE-SCAN', passed: false, reason: `Chỉ có ${buyers.length}/${settings.monitoring.earlyBuyersToMonitor} ví mua trong thời gian theo dõi.` },
            { ruleId: 'preliminary_timeout', ruleName: 'Thời gian chờ', ruleType: 'PRE-SCAN', passed: false, reason: `Quá hạn theo dõi (${Math.floor(durationMs/60000)} phút).` }
          ]
        };

        // Record as detailed FAIL
        tracker.recordScan({
          mint,
          tokenName: token.name,
          tokenSymbol: token.symbol,
          deployer: token.deployer,
          ruleResult: finalRuleResult,
          actionTaken: 'BLOCKED',
          isFinal: true,
          timestamp: Date.now()
        });

        // Emit final state to UI so retry counter shows ⏹️ and stops updating
        try {
          webServer.emit('analysisResult', {
            tokenData: { ...token, analysisTimestamp: Date.now() },
            ruleResult: finalRuleResult,
            earlyBuyers: [],
            earlyBuyerTrades: [],
            globalFee: this.tokenGlobalFees.get(mint) || 0,
            solPrice: priceService.solPrice || 150,
            retryCount: Math.max(
              tracker.getScanCount(mint),
              (this._rescanAttempts.get(mint) || 0) + 1
            ),
            isFinal: true,
          });
        } catch (emitErr) {
          logger.debug(`Final-state emit failed for ${shortenAddress(mint)}: ${emitErr.message}`);
        }

        // Mark as analyzed so we don't process it again
        this.analyzedTokens.add(mint);

        // Clean up memory
        this.tokenData.delete(mint);
        this.tokenEarlyBuyers.delete(mint);
        this.tokenGlobalFees.delete(mint);
        this.tokenTradeHistory.delete(mint);
        this.holderStatsCache.delete(mint);
        this._rescanAttempts.delete(mint);
      }
    }

    // Prune orphaned Set entries to prevent unbounded growth
    // analyzedTokens/passedTokens can accumulate mints that were already removed from tokenData
    const MAX_SET_SIZE = 500;
    if (this.analyzedTokens.size > MAX_SET_SIZE) {
      for (const mint of this.analyzedTokens) {
        if (!this.tokenData.has(mint)) this.analyzedTokens.delete(mint);
      }
    }
    if (this.passedTokens.size > MAX_SET_SIZE) {
      for (const mint of this.passedTokens) {
        if (!this.tokenData.has(mint)) this.passedTokens.delete(mint);
      }
    }
  }

  /**
   * Execute buy order
   */
  async _executeBuy(mint, tokenData, ruleResult) {
    const dailyLoss = tracker.getDailyLoss();
    const positionCount = sellExecutor.getPositionCount();

    const canBuy = buyExecutor.canBuy(positionCount, dailyLoss);
    if (!canBuy.allowed) {
      logger.info(`🚫 Buy blocked: ${canBuy.reason}`);
      return;
    }

    if (!settings.trading.autoBuyEnabled) {
      logger.info(`⏸ Auto-buy disabled. Token ${tokenData.symbol} eligible - waiting for manual confirmation via Telegram.`);
      return;
    }

    // Retry loop at orchestrator level: if buyToken fails all internal attempts,
    // wait 1 second and try the entire buy flow once more
    const MAX_ORCHESTRATOR_RETRIES = 2; // Total: 2 orchestrator attempts × 3 internal attempts = 6 tries max
    let buyResult = null;

    for (let retry = 1; retry <= MAX_ORCHESTRATOR_RETRIES; retry++) {
      const retryTag = retry > 1 ? ` [Orch Retry ${retry - 1}]` : '';
      logger.info(`🛒${retryTag} Executing auto-buy for ${tokenData.symbol}...`);

      buyResult = await buyExecutor.buyToken(mint, settings.trading.buyAmountSol);

      if (buyResult.success) {
        break; // Success — exit retry loop
      }

      // If this wasn't the last retry, wait 1 second before trying again
      if (retry < MAX_ORCHESTRATOR_RETRIES) {
        logger.warn(`⚠️ Buy failed for ${tokenData.symbol}: ${buyResult.error}. Retrying in 1s...`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (buyResult.success) {
      // Record trade
      tracker.recordBuy({
        mint,
        tokenName: tokenData.name,
        tokenSymbol: tokenData.symbol,
        solAmount: settings.trading.buyAmountSol,
        signature: buyResult.signature,
        reason: 'AUTO',
        timestamp: Date.now(),
      });

      // Add to position tracking for TP/SL
      sellExecutor.addPosition(mint, {
        solAmount: buyResult.solAmount || settings.trading.buyAmountSol,
        tokenAmount: buyResult.tokenAmount || 0,
        marketCapSol: tokenData.marketCapSol,
      });

      // Start monitoring for TP/SL
      sellExecutor.startMonitoring(mint);

      // Notify (non-blocking)
      telegram.sendBuyNotification(buyResult, tokenData).catch(e => logger.error(`Buy notification failed: ${e.message}`));
    } else {
      logger.error(`❌ All buy attempts exhausted for ${tokenData.symbol}: ${buyResult.error}`);
      // Notify failure (non-blocking)
      telegram.sendBuyNotification(buyResult, tokenData).catch(e => logger.error(`Buy notification failed: ${e.message}`));
    }
  }

  /**
   * Execute sell order
   */
  async _executeSell(sellAction) {
    // Deduplication lock: prevent concurrent sells for the same mint
    if (!this._sellingMints) this._sellingMints = new Set();
    if (this._sellingMints.has(sellAction.mint)) {
      logger.info(`⚠️ Sell already in progress for ${shortenAddress(sellAction.mint)}, skipping duplicate.`);
      return;
    }
    this._sellingMints.add(sellAction.mint);

    try {
      const sellResult = await sellExecutor.sellToken(sellAction.mint, 100);

      tracker.recordSell({
        mint: sellAction.mint,
        reason: sellAction.reason,
        pnlSol: sellAction.pnlSol || 0,
        pnlPercent: sellAction.pnlPercent,
        signature: sellResult.signature,
        timestamp: Date.now(),
      });

      await telegram.sendSellNotification(sellResult, sellAction.reason, sellAction.pnlPercent, sellAction.pnlSol);
    } finally {
      this._sellingMints.delete(sellAction.mint);
    }
  }

  /**
   * Handle Telegram bot commands
   */
  async _handleTelegramCommand(command, params) {
    switch (command) {
      case 'status': {
        const balance = await solana.getBalance();
        const stats = tracker.getTodayStats();
        const positions = sellExecutor.getPositionCount();
        const wr = tracker.getWinRateStats();
        const fmtWr = (d) => d && d.total > 0 ? `${d.winRate.toFixed(1)}% (${d.wins}W/${d.losses}L)${d.avgPnlPercent !== undefined ? ` | PnL: ${d.avgPnlPercent >= 0 ? '+' : ''}${d.avgPnlPercent.toFixed(1)}%` : ''}` : 'N/A';
        return (
          `*🤖 Trạng thái Bot*\n\n` +
          `Ví: \`${solana.getPublicKey().toBase58()}\`\n` +
          `Trạng thái: ${this.isPaused ? '⏸ Tạm dừng' : '🟢 Đang chạy'}\n` +
          `Tự động mua: ${settings.trading.autoBuyEnabled ? 'BẬT ✅' : 'TẮT ❌'}\n` +
          `Số dư: ${formatSol(balance)}\n` +
          `Vị thế đang mở: ${positions}/${settings.trading.maxConcurrentPositions}\n` +
          `Số SOL mỗi lệnh: ${formatSol(settings.trading.buyAmountSol)}\n` +
          `Chốt lời: ${settings.risk.takeProfitPercent}% | Cắt lỗ: ${settings.risk.stopLossPercent}%\n\n` +
          `*Hôm nay:*\n` +
          `Đã quét: ${stats.tokensScanned} | Đã mua: ${stats.tokensBought} | Đã bán: ${stats.tokensSold}\n` +
          `Lãi/lỗ: ${stats.totalPnlSol >= 0 ? '+' : ''}${formatSol(stats.totalPnlSol)}\n\n` +
          `*📊 Win Rate (ATH PnL):*\n` +
          `Hôm nay (9h): ${fmtWr(wr['1d'])}\n` +
          `3D: ${fmtWr(wr['3d'])}\n` +
          `7D: ${fmtWr(wr['7d'])}\n` +
          `ALL: ${fmtWr(wr['all'])}`
        );
      }

      case 'positions': {
        const positions = sellExecutor.getPositions();
        if (positions.length === 0) return '*Không có vị thế nào đang mở*';
        let text = `*📊 Vị thế đang mở (${positions.length})*\n\n`;
        for (const pos of positions) {
          text += `\`${shortenAddress(pos.mint)}\` | Mua: ${formatSol(pos.buyAmountSol || 0)}\n`;
        }
        return text;
      }
      case 'pnl': {
        const stats = tracker.getTodayStats();
        const wr = tracker.getWinRateStats();
        const fmtWr = (d) => d && d.total > 0 ? `${d.winRate.toFixed(1)}% (${d.wins}W/${d.losses}L)${d.avgPnlPercent !== undefined ? ` | PnL: ${d.avgPnlPercent >= 0 ? '+' : ''}${d.avgPnlPercent.toFixed(1)}%` : ''}` : 'N/A';
        return (
          `*📈 Lãi/lỗ hôm nay*\n\n` +
          `Tổng: ${stats.totalPnlSol >= 0 ? '+' : ''}${formatSol(stats.totalPnlSol)}\n` +
          `Thắng: ${stats.wins} | Thua: ${stats.losses}\n\n` +
          `*📊 Win Rate (ATH PnL):*\n` +
          `Hôm nay (9h): ${fmtWr(wr['1d'])}\n` +
          `3D: ${fmtWr(wr['3d'])}\n` +
          `7D: ${fmtWr(wr['7d'])}\n` +
          `ALL: ${fmtWr(wr['all'])}`
        );
      }

      case 'reset_pnl': {
        const confirmed = params.confirmed === true;
        if (!confirmed) {
          return {
            text: '*⚠️ XÁC NHẬN RESET LÃI LỖ?*\n\nHành động này sẽ xóa sạch lịch sử giao dịch và các vị thế đang mở. Token đã quét vẫn sẽ được giữ lại.',
            keyboard: [
              [
                { text: '✅ Xác nhận Reset', callback_data: 'wallet:reset_pnl_confirmed' },
                { text: '❌ Hủy', callback_data: 'wallet:status' }
              ]
            ]
          };
        }
        
        const success = await this.resetAllStats();
        return success ? '✅ *Đã reset toàn bộ lãi lỗ và vị thế thành công!*' : '❌ *Lỗi khi thực hiện reset.*';
      }

      case 'rules': {
        const rules = ruleEngine.getRules();
        const typeLabels = {
          REQUIRE: '🔒 BẮT BUỘC',
          ALERT: '⚠️ CẢNH BÁO',
          INFO: 'ℹ️ THÔNG TIN',
        };
        let text = '*📋 DANH SÁCH ĐIỀU KIỆN LỌC*\n\n';
        for (const rule of rules) {
          const status = rule.enabled ? '✅' : '❌';
          text += `${status} *${rule.name}* (${typeLabels[rule.type] || rule.type})\n`;

          let details = [];
          if (rule.minMarketCapSol) details.push(`MCap: >= ${rule.minMarketCapSol} SOL`);
          if (rule.maxPercent) details.push(`Ngưỡng: < ${rule.maxPercent}%`);
          if (rule.minVol) details.push(`Volume: > ${rule.minVol} SOL`);
          if (rule.maxMinutes) details.push(`Thời gian: < ${rule.maxMinutes} phút`);
          if (rule.tolerancePercent) details.push(`Sai số: ${rule.tolerancePercent}%`);
          if (rule.maxRiskScore) details.push(`Rủi ro tối đa: ${rule.maxRiskScore}`);
          if (rule.id === 'same_buy_amount') details.push(`Số ví tối thiểu: 3`);
          if (rule.retryable) details.push(`🔄 Quét lại liên tục`);

          if (details.length > 0) {
            text += `   [ ${details.join(' | ')} ]\n`;
          }
          text += `   _${rule.description}_\n`;
          text += `   ID: \`${rule.id}\`\n\n`;
        }
        text += `*Hướng dẫn:*\n`;
        text += `• Bật/tắt: /toggle\\_rule <id>\n`;
        text += `• Profile: /profiles | /apply\\_profile <id>\n`;
        text += `• VD: /toggle\\_rule dev\\_risk\\_check\n`;
        return text;
      }

      case 'profiles': {
        const profiles = getRuleProfiles();
        const activeProfile = ruleEngine.getActiveProfile();
        let text = '*🧭 RULE PROFILES*\n\n';
        for (const profile of profiles) {
          const activeMark = profile.id === activeProfile ? '✅' : '•';
          text += `${activeMark} *${profile.name}*\n`;
          text += `   ID: \`${profile.id}\`\n`;
          text += `   ${profile.description}\n\n`;
        }
        if (activeProfile === 'custom') {
          text += `• *Custom*\n`;
          text += `   ID: \`custom\`\n`;
          text += `   Trạng thái hiện tại đã bị chỉnh tay sau khi áp preset.\n\n`;
        }
        text += '*Dùng:* /apply\\_profile <id>\n';
        return text;
      }

      case 'apply_profile': {
        if (!params.profileId) {
          return 'Cách dùng: /apply\\_profile <id>\nVD: /apply\\_profile balanced_backup3';
        }
        const profile = getRuleProfile(params.profileId);
        if (!profile) {
          return `❌ Không tìm thấy profile \`${params.profileId}\`\nGõ /profiles để xem danh sách`;
        }

        applyRuleProfile(ruleEngine, params.profileId);
        persistAppliedRuleProfile(tracker, ruleEngine, params.profileId);

        return `✅ Đã áp dụng profile \`${profile.id}\` (${profile.name})`;
      }

      case 'toggle_rule': {
        if (!params.ruleId) return 'Cách dùng: /toggle\\_rule <rule\\_id>\nVD: /toggle\\_rule cluster\\_detection';
        const rules = ruleEngine.getRules();
        const rule = rules.find(r => r.id === params.ruleId);
        if (!rule) return `❌ Không tìm thấy điều kiện \`${params.ruleId}\`\nGõ /rules để xem danh sách`;
        ruleEngine.toggleRule(params.ruleId, !rule.enabled);
        tracker.saveRuleState(params.ruleId, !rule.enabled);
        markProfileAsCustom(tracker, ruleEngine);
        return `✅ Điều kiện \`${params.ruleId}\`: ${!rule.enabled ? 'ĐÃ BẬT ✅' : 'ĐÃ TẮT ❌'}`;
      }

      case 'set_mcap': {
        if (!params.amount || params.amount <= 0) return 'Cách dùng: /set\\_mcap <số SOL>\nVD: /set\\_mcap 15\n\nToken phải đạt MCap này mới pass. Nếu chưa đạt sẽ quét lại liên tục.';
        ruleEngine.updateRule('market_cap_check', { minMarketCapSol: params.amount });
        tracker.saveBotSetting('rule_market_cap_check_minMarketCapSol', params.amount);
        markProfileAsCustom(tracker, ruleEngine);
        return `✅ Min Market Cap: ${params.amount} SOL\nToken chưa đạt sẽ được quét lại liên tục đến khi đạt hoặc quá ${this._getMaxAgeMinutes()} phút.`;
      }

      case 'set_amount': {
        if (!params.amount || params.amount <= 0) return 'Cách dùng: /set\\_amount <số SOL>\nVD: /set\\_amount 0.5';
        settings.trading.buyAmountSol = params.amount;
        tracker.saveBotSetting('buyAmountSol', params.amount);
        return `✅ Số SOL mỗi lệnh mua: ${formatSol(params.amount)}`;
      }

      case 'set_tp': {
        if (!params.percent || params.percent <= 0) return 'Cách dùng: /set\\_tp <phần trăm>\nVD: /set\\_tp 100';
        settings.risk.takeProfitPercent = params.percent;
        tracker.saveBotSetting('takeProfitPercent', params.percent);
        return `✅ Chốt lời đặt: ${params.percent}%`;
      }

      case 'set_sl': {
        if (!params.percent || params.percent <= 0) return 'Cách dùng: /set\\_sl <phần trăm>\nVD: /set\\_sl 50';
        settings.risk.stopLossPercent = params.percent;
        tracker.saveBotSetting('stopLossPercent', params.percent);
        return `✅ Cắt lỗ đặt: ${params.percent}%`;
      }

      case 'auto_buy': {
        settings.trading.autoBuyEnabled = params.enabled;
        tracker.saveBotSetting('autoBuyEnabled', params.enabled);
        return `Tự động mua: ${params.enabled ? 'BẬT ✅' : 'TẮT ❌'}`;
      }

      case 'auto_sell': {
        settings.trading.autoSellEnabled = params.enabled;
        tracker.saveBotSetting('autoSellEnabled', params.enabled);
        return `Tự động bán: ${params.enabled ? 'BẬT ✅' : 'TẮT ❌'}`;
      }

      case 'sell': {
        if (!params.mint) return 'Cách dùng: /sell <mint address>';
        const result = await sellExecutor.sellToken(params.mint, 100);
        return result.success
          ? `✅ Đã bán: \`${result.signature}\``
          : `❌ Bán thất bại: ${result.error}`;
      }

      case 'history': {
        const trades = tracker.getTradeHistory(10);
        if (trades.length === 0) return '*Chưa có lịch sử giao dịch*';
        let text = '*📜 Lịch sử giao dịch*\n\n';
        for (const t of trades) {
          const emoji = t.action === 'BUY' ? '🛒' : '🔄';
          const label = t.action === 'BUY' ? 'Mua' : 'Bán';
          text += `${emoji} ${label} \`${shortenAddress(t.mint)}\` ${formatSol(t.sol_amount)}`;
          if (t.pnl_percent) text += ` (${t.pnl_percent > 0 ? '+' : ''}${t.pnl_percent.toFixed(1)}%)`;
          text += '\n';
        }
        return text;
      }

      case 'config': {
        const rules = ruleEngine.getRules();
        const typeLabels = { REQUIRE: 'Bắt buộc', ALERT: 'Cảnh báo', INFO: 'Thông tin' };
        let text = `*⚙️ CẤU HÌNH HIỆN TẠI*\n\n`;
        text += `*🧭 Profile:* \`${ruleEngine.getActiveProfile()}\`\n\n`;
        text += `*💰 Giao dịch:*\n`;
        text += `• Tự động mua: ${settings.trading.autoBuyEnabled ? 'BẬT ✅' : 'TẮT ❌'}\n`;
        text += `• Số SOL mỗi lệnh: ${formatSol(settings.trading.buyAmountSol)}\n`;
        text += `• Tối đa vị thế: ${settings.trading.maxConcurrentPositions}\n`;
        text += `• Giới hạn lỗ/ngày: ${formatSol(settings.trading.dailyLossLimitSol)}\n\n`;
        text += `*🛡 Quản lý rủi ro:*\n`;
        text += `• Chốt lời: ${settings.risk.takeProfitPercent}%\n`;
        text += `• Cắt lỗ: ${settings.risk.stopLossPercent}%\n\n`;

        text += `*📋 Điều kiện (${rules.filter(r => r.enabled).length}/${rules.length} đang bật):*\n`;
        for (const rule of rules) {
          text += `${rule.enabled ? '✅' : '❌'} *${rule.name}*\n`;
          let details = [];
          if (rule.maxPercent) details.push(`Ngưỡng: < ${rule.maxPercent}%`);
          if (rule.minVol) details.push(`Volume: > ${rule.minVol} SOL`);
          if (rule.maxMinutes) details.push(`Thời gian: < ${rule.maxMinutes} phút`);
          if (rule.tolerancePercent) details.push(`Sai số: ${rule.tolerancePercent}%`);
          if (rule.maxRiskScore) details.push(`Rủi ro tối đa: ${rule.maxRiskScore}`);
          if (rule.id === 'same_buy_amount') details.push(`Số ví tối thiểu: 3`);
          
          if (details.length > 0) {
            text += `   [${details.join(' | ')}]\n`;
          }
          text += `   ${rule.description}\n\n`;
        }

        text += `\n*⌨️ Lệnh chỉnh:*\n`;
        text += `/set\\_amount <sol> — Số SOL mua\n`;
        text += `/set\\_tp <số> — Chốt lời %\n`;
        text += `/set\\_sl <số> — Cắt lỗ %\n`;
        text += `/toggle\\_rule <id> — Bật/tắt điều kiện\n`;
        text += `/profiles — Xem profiles\n`;
        text += `/apply\\_profile <id> — Áp preset chiến lược\n`;
        return text;
      }

      case 'set_buyers': {
        if (!params.count || params.count < 1 || params.count > 20) return 'Cách dùng: /set\\_buyers <1-20>\nVD: /set\\_buyers 10';
        settings.monitoring.earlyBuyersToMonitor = params.count;
        tracker.saveBotSetting('earlyBuyersToMonitor', params.count);
        markProfileAsCustom(tracker, ruleEngine);
        return `✅ Số ví mua sớm theo dõi: ${params.count}`;
      }

      case 'set_fee': {
        if (!params.threshold || params.threshold < 0) return 'Cách dùng: /set\\_fee <sol>\nVD: /set\\_fee 1.0';
        settings.monitoring.globalFeeThreshold = params.threshold;
        tracker.saveBotSetting('globalFeeThreshold', params.threshold);
        ruleEngine.updateRule('global_fee_threshold', { minGlobalFee: params.threshold });
        tracker.saveBotSetting('rule_global_fee_threshold_minGlobalFee', params.threshold);
        markProfileAsCustom(tracker, ruleEngine);
        return `✅ Ngưỡng Global Fee: ${params.threshold} SOL`;
      }

      case 'pause':
        this.isPaused = true;
        return '⏸ Bot đã tạm dừng. Gõ /resume để chạy lại.';

      case 'resume':
        this.isPaused = false;
        return '▶️ Bot đang chạy lại. Đang quét PumpFun...';

      case 'reset': {
        await telegram.sendMessage('🔄 <b>Bot đang khởi động lại...</b>\nVui lòng đợi khoảng 5-10 giây.');
        setTimeout(() => process.exit(0), 1000);
        return null;
      }

      case 'confirm_buy': {
        if (!params.mint) return;
        const tokenData = this.tokenData.get(params.mint);
        if (!tokenData) return '❌ Dữ liệu token đã hết hạn';
        await this._executeBuy(params.mint, tokenData, { shouldBuy: true });
        return null;
      }

      case 'web':
      case 'link': {
        const port = process.env.WEB_PORT || 3000;
        const localLink = `http://192.168.1.240:${port}`;
        const ip = '14.167.185.37';
        return (
          `*🌐 Link Truy Cập Dashboard*\n\n` +
          `• *Cách 1: Gửi bạn bè (Dễ nhất - Không mật khẩu)*\n` +
          `Copy lệnh dán vào Terminal của bạn:\n` +
          `\`ssh -R 80:localhost:${port} pinggy.io\`\n` +
          `_(Gửi link https://... nhận được cho bạn bè xem ngay)_\n\n` +
          `• *Cách 2: Mạng nội bộ (Wifi nhà)*\n` +
          `[${localLink}](${localLink})\n\n` +
          `• *Cách 3: Dự phòng (Localtunnel)*\n` +
          `Lệnh: \`npx localtunnel --port ${port}\`\n` +
          `IP xác thực: \`${ip}\``
        );
      }

      default:
        return 'Lệnh không hợp lệ. Gõ /start để xem danh sách lệnh.';
    }
  }

  /**
   * Cleanup old token data to prevent memory leaks
   */
  /**
   * Fetch historical buyers from RPC history to recover state after restarts
   */
  async _fetchHistoricalBuyers(mint) {
    try {
      logger.info(`🔍 Fetching historical buyers for ${shortenAddress(mint)} from RPC...`);
      
      let lastSig = null;
      let allSigs = [];
      const MAX_SIGS = 3000; // Safety limit to avoid hanging on massive tokens
      
      // Paginate backwards through history to find the absolute beginning
      while (allSigs.length < MAX_SIGS) {
        const options = { limit: 1000 };
        if (lastSig) options.before = lastSig;
        
        const sigs = await solana.execute(conn => conn.getSignaturesForAddress(new PublicKey(mint), options));
        if (!sigs || sigs.length === 0) break;
        
        allSigs = allSigs.concat(sigs);
        lastSig = sigs[sigs.length - 1].signature;
        
        // If we got fewer than 1000, we've reached the very first transaction
        if (sigs.length < 1000) break;
      }
      
      if (allSigs.length === 0) return [];

      // The EARLIEST transactions are at the end of the allSigs array (newest-to-oldest order).
      // We take the 25 oldest transactions and process them in chronological order.
      const oldestSigsSlice = allSigs.slice(-25).reverse();
      
      const buyers = [];
      const seen = new Set();
      
      for (const sig of oldestSigsSlice) {
        try {
          const parsed = await solana.executeRace(conn => 
            conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 })
          );
          
          if (parsed && parsed.transaction.message.accountKeys) {
            const signerAccount = parsed.transaction.message.accountKeys.find(ak => ak.signer);
            if (signerAccount) {
              const addr = signerAccount.pubkey.toBase58();
              if (!seen.has(addr)) {
                seen.add(addr);
                
                // Calculate SOL spent: (preBalance - postBalance - fee) / 1e9
                const signerIndex = parsed.transaction.message.accountKeys.findIndex(ak => ak.pubkey.toBase58() === addr);
                let solAmount = 0;
                if (signerIndex !== -1 && parsed.meta) {
                  const pre = parsed.meta.preBalances[signerIndex];
                  const post = parsed.meta.postBalances[signerIndex];
                  const fee = parsed.meta.fee || 0;
                  // For a BUY, pre > post. The difference minus fee is the amount sent to the bonding curve.
                  solAmount = Math.max(0, (pre - post - fee) / 1e9);
                }

                buyers.push({
                  address: addr,
                  solAmount: solAmount,
                  timestamp: sig.blockTime ? sig.blockTime * 1000 : Date.now(),
                  signature: sig.signature
                });
              }
            }
          }
        } catch (e) {
          logger.debug(`Failed to parse history tx ${sig.signature}: ${e.message}`);
        }
      }
      // Return identified buyers in discovery order
      return buyers;
    } catch (err) {
      logger.error(`Failed to fetch historical buyers for ${mint}: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetch the original deployer from blockchain history if missing from API data
   */
  async _fetchDeployerFromHistory(mint) {
    try {
      logger.info(`🔍 Recovering deployer for ${shortenAddress(mint)} from RPC...`);
      
      let lastSig = null;
      let oldestSig = null;
      const MAX_SIGS = 3000;
      let count = 0;

      // Paginate back to the absolute beginning to find the creation transaction
      while (count < MAX_SIGS) {
        const options = { limit: 1000 };
        if (lastSig) options.before = lastSig;
        
        const sigs = await solana.execute(conn => conn.getSignaturesForAddress(new PublicKey(mint), options));
        if (!sigs || sigs.length === 0) break;
        
        oldestSig = sigs[sigs.length - 1].signature;
        lastSig = oldestSig;
        count += sigs.length;
        if (sigs.length < 1000) break;
      }
      
      if (!oldestSig) return null;
      
      const tx = await solana.execute(conn => 
        conn.getParsedTransaction(oldestSig, { maxSupportedTransactionVersion: 0 })
      );
      
      if (tx && tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) {
        const signerAccount = tx.transaction.message.accountKeys.find(ak => ak.signer);
        if (signerAccount) {
          return signerAccount.pubkey.toBase58();
        }
      }
      return null;
    } catch (e) {
      logger.error(`Error recovering deployer for ${mint}: ${e.message}`);
      return null;
    }
  }


  // Manual refresh from dashboard
  async manualTokenRefresh(mint) {
    logger.info(`🔄 Manual refresh requested for ${mint}...`);
    try {
      let tokenData;
      
      // 1. Resolve basic metadata (Memory -> DB -> DX)
      // ALWAYS fetch fresh market data even if it's in memory to ensure we are up to date
      const scan = tracker.getScanForMint(mint);
      const pairs = await priceService.getTokensData([mint]);
      const p = (pairs && pairs.length > 0) ? (priceService.selectBestPairForMint(pairs, mint) || pairs[0]) : null;
      const solPrice = await priceService.getSolPrice() || 150;
      
      const volUsd = p?.volume?.h24 || p?.volume?.h6 || p?.volume?.h1 || 0;
      const volSol = volUsd / solPrice;
      const mcapUsd = p?.marketCap || p?.fdv || scan?.highest_mcap_usd || 0;
      
      // Update global fee cache so the emitted result is consistent with the latest data
      const currentGlobalFee = volSol / 100;
      this.tokenGlobalFees.set(mint, currentGlobalFee);

      tokenData = {
        mint,
        symbol: p?.baseToken?.symbol || scan?.token_symbol || '???',
        name: p?.baseToken?.name || scan?.token_name || 'Unknown',
        deployer: scan?.deployer || '',
        marketCapSol: mcapUsd / solPrice,
        marketCapUsd: mcapUsd,
        circulatingMcapSol: mcapUsd / solPrice,
        circulatingMcapUsd: mcapUsd,
        volume: volSol,
        globalFee: currentGlobalFee,
        pairAddress: p?.pairAddress || null,
        axiomRouteAddress: p?.pairAddress || null,
        timestamp: scan?.timestamp || Date.now(),
        isManual: true
      };
      
      this.tokenData.set(mint, tokenData);
      logger.info(`Initialized tokenData for ${tokenData.symbol} (${shortenAddress(mint)}) from ${p ? 'DexScreener' : 'DB/Fallback'}`);

      // 2. CRITICAL: Recover deployer if missing
      if (!tokenData.deployer || tokenData.deployer === '' || tokenData.deployer === 'UNKNOWN') {
        const recoveredDeployer = await this._fetchDeployerFromHistory(mint);
        if (recoveredDeployer) {
          tokenData.deployer = recoveredDeployer;
          logger.info(`✅ Recovered deployer for ${shortenAddress(mint)}: ${shortenAddress(recoveredDeployer)}`);
        } else {
          logger.warn(`⚠️ Failed to find deployer on-chain for ${shortenAddress(mint)}`);
          tokenData.deployer = 'UNKNOWN';
        }
      }

      // 3. Sync database with latest MCap
      if (tokenData.marketCapUsd > 0) {
        tracker.updateCurrentMcap(mint, tokenData.marketCapUsd);
        const latestScan = tracker.getScanForMint(mint);
        if (tokenData.marketCapUsd > (latestScan?.highest_mcap_usd || 0)) {
          tracker.updateHighestMcap(mint, tokenData.marketCapUsd, Date.now());
        }
      }

      // 4. Subscribe to real-time events
      detector.subscribeToToken(mint);

      // 5. Recover historical buyers if missing
      const currentBuyers = this.tokenEarlyBuyers.get(mint);
      if (!currentBuyers || currentBuyers.length === 0) {
        const history = await this._fetchHistoricalBuyers(mint);
        if (history.length > 0) {
          this.tokenEarlyBuyers.set(mint, history);
          logger.info(`✅ Recovered ${history.length} historical participants for ${shortenAddress(mint)}`);
        }
      }

      // 6. Final Step: Run full analysis
      logger.info(`🚀 Starting full analysis for ${tokenData.symbol} (${shortenAddress(mint)})`);
      await this._runFullAnalysis(mint);
      
      // Update UI
      webServer.emit('passedTokensUpdate', tracker.getPassedTokens24h());
      webServer.emit('topPnLUpdate', tracker.getTopPnLTokens('24h'));
      
    } catch (e) {
      logger.error(`Error in manual refresh for ${mint}: ${e.message}`);
    }
  }

  _cleanup() {
    const maxAge = (this._getMaxAgeMinutes() + 1) * 60 * 1000; // configurable + 1 min buffer
    const now = Date.now();

    for (const [mint, data] of this.tokenData) {
      if (now - data.timestamp > maxAge && !sellExecutor.getPositions().some(p => p.mint === mint)) {
        this._clearPendingRecheck(mint);
        const safetyId = this._safetyNetTimeouts.get(mint);
        if (safetyId) { clearTimeout(safetyId); this._safetyNetTimeouts.delete(mint); }
        this.tokenData.delete(mint);
        this.tokenEarlyBuyers.delete(mint);
        this.tokenGlobalFees.delete(mint);
        this.tokenTradeHistory.delete(mint);
        this.passedTokens.delete(mint);
        this.analyzedTokens.delete(mint);
        this.processingTokens.delete(mint);
        this.holderStatsCache.delete(mint);
        this._rescanAttempts.delete(mint);
        detector.unsubscribeFromToken(mint);
      }
    }
  }

  /**
   * Graceful shutdown
   */
  async stop() {
    logger.info('Shutting down...');
    if (this._analysisHealthInterval) {
      clearInterval(this._analysisHealthInterval);
      this._analysisHealthInterval = null;
    }
    detector.stop();
    telegram.stop();
    tracker.close();
    logger.info('Bot stopped.');
  }
  /**
   * Complete system reset for trade data
   */
  async resetAllStats() {
    try {
      logger.warn('🔄 Initiating full PnL and trade data reset...');
      
      // 1. Reset Database
      tracker.resetData();
      
      // 2. Clear Sell Executor (Memory + Intervals)
      sellExecutor.clearAllPositions();
      
      logger.info('✅ Full reset completed successfully.');
      return true;
    } catch (err) {
      logger.error(`Reset failed: ${err.message}`);
      return false;
    }
  }
}

module.exports = new Orchestrator();
