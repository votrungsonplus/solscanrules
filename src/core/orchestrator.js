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

class Orchestrator extends EventEmitter {
  constructor() {
    super();
    this.isPaused = false;
    this.tokenEarlyBuyers = new Map(); // mint -> [{ address, solAmount }]
    this.tokenData = new Map(); // mint -> token data
    this.tokenGlobalFees = new Map(); // mint -> cumulative trading fees (1% of volume)
    this.processingTokens = new Set(); // tokens currently being analyzed
    this.passedTokens = new Set(); // tokens that successfully passed all rules
    this.analyzedTokens = new Set(); // track ALL tokens recorded to scans (pass or fail)
    this.holderStatsCache = new Map(); // mint -> { data, timestamp }
    this.pendingRechecks = new Map(); // mint -> timeout id
    this._safetyNetTimeouts = new Map(); // mint -> timeout id for 5s safety-net
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
    const pending = this.pendingRechecks.get(mint);
    if (pending) {
      clearTimeout(pending);
      this.pendingRechecks.delete(mint);
    }
  }

  _scheduleRecheck(mint, delayMs, reason) {
    const tokenData = this.tokenData.get(mint);
    if (!tokenData || this.passedTokens.has(mint)) return;

    const ageMinutes = (Date.now() - tokenData.timestamp) / 60000;
    const maxAge = this._getMaxAgeMinutes();
    if (ageMinutes >= maxAge) {
      logger.info(`⏹️ ${tokenData.symbol || shortenAddress(mint)} hết tuổi re-check (${ageMinutes.toFixed(1)}m/${maxAge}m).`);
      return;
    }

    this._clearPendingRecheck(mint);
    logger.info(`🔄 ${tokenData.symbol || shortenAddress(mint)} ${reason} (${ageMinutes.toFixed(1)}m/${maxAge}m). Re-scan sau ${Math.round(delayMs / 1000)}s...`);

    const timeoutId = setTimeout(() => {
      this.pendingRechecks.delete(mint);
      if (this.tokenData.has(mint) && !this.passedTokens.has(mint) && !this.processingTokens.has(mint)) {
        this.processingTokens.add(mint);
        if (!this._analysisQueue) this._analysisQueue = [];
        this._analysisQueue.push(mint);
        this._processAnalysisQueue();
      }
    }, delayMs);

    this.pendingRechecks.set(mint, timeoutId);
  }

  /**
   * Initialize all components and start the bot
   */
  async start() {
    logger.info('═══════════════════════════════════════════');
    logger.info('   SCAN SOL BOT - PumpFun Sniper');
    logger.info('═══════════════════════════════════════════');

    // 1. Initialize Solana connection
    solana.init();
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
    ruleEngine.setActiveProfile(tracker.getBotSetting('activeRuleProfile', 'custom'));
    
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
    logger.info(`Loaded persistent settings (Auto-Buy: ${settings.trading.autoBuyEnabled}, Amount: ${settings.trading.buyAmountSol} SOL, Min MCap: ${mcapRule?.minMarketCapSol || 10} SOL, Max Age: ${ageRule?.maxMinutes || 5}m)`);

    // 4. Initialize Telegram bot (non-blocking)
    telegram.init((command, params) => this._handleTelegramCommand(command, params));
    telegram.start().catch(err => logger.error(`Telegram start error: ${err.message}`));

    // 4. Start PumpFun detector
    detector.start();

    // 5. Set up event handlers
    this._setupEventHandlers();

    // 8. Start cleanup timer for "Timed out" tokens
    this._startCleanupTimer();

    logger.info('Bot is now running and monitoring PumpFun...');
    logger.info(`Auto-buy: ${settings.trading.autoBuyEnabled ? 'ON' : 'OFF'}`);
    logger.info(`Buy amount: ${formatSol(settings.trading.buyAmountSol)}`);
    logger.info(`Monitoring ${settings.monitoring.earlyBuyersToMonitor} early buyers per token`);
    logger.info(`TP: ${settings.risk.takeProfitPercent}% | SL: ${settings.risk.stopLossPercent}%`);

    // 9. Start periodic web data synchronization
    this._startWebSync();

    // 10. Start Safety Stop Loss checker (every 60s)
    this._startSafetyCheck();
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

    // Record to database for persistence
    tracker.recordDetectedToken({
      mint,
      symbol: tokenData.symbol,
      name: tokenData.name,
      timestamp: tokenData.timestamp
    });

    logger.info(`New token: ${tokenData.symbol} | Deployer: ${shortenAddress(tokenData.deployer)} | MCap: ${tokenData.marketCapSol?.toFixed(2)} SOL`);

    // If deployer made an initial buy, add as first early buyer and trigger analysis
    if (tokenData.solAmount > 0) {
      this.tokenEarlyBuyers.get(mint).push({
        address: tokenData.deployer,
        solAmount: tokenData.solAmount || 0,
        tokenAmount: tokenData.tokenAmount || 0,
        timestamp: Date.now(),
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

    // Track early buyers — skip if token not tracked (trade arrived before create event or untracked token)
    const earlyBuyers = this.tokenEarlyBuyers.get(mint);
    if (!earlyBuyers) return;

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
  async _fetchTokenHolders(mint, deployer, earlyBuyerWallets = [], bundleWallets = new Set(), tokenTimestamp = Date.now()) {
    try {
      const cacheTtlMs = 20000;
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

      // Exclude bonding/system owners and the token accounts they control from holder concentration.
      // We compare at both owner-level and token-account-level because largest accounts returns token accounts.
      const excludedOwners = new Set([
        bondingCurvePDA.toBase58(),
        '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', // PumpFun migration authority
        'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ2j6BgsF66z', // PumpFun fee account
        'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1', // PumpFun fee account 2
        'CebN5WGZ4jvStp3MLuW6S6T4Ez7B4PmezeNVasJp69ov', // Legacy/alt migration authority seen in prior code
        'TSLvddqTZ24pYp3zXW728EKEpCKA8atuVnJkz78S79z', // Legacy global fee account seen in prior code
        '5Q544fKrMJu97H5G98M5QXT7sAUPtUvyP5D9S6gBfGnd', // Raydium authority (if migrated)
        '4e6eTeeM9ojnT2D1297q6NngaMgChA3mZTXdRvs5xPz7', // Additional PumpFun system wallet
        '6pjkAgzWJvqxVbwwumU1gin5pDyDdM2eaNXKTv3B7NPN', // Additional PumpFun system wallet
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

      // Fetch largest accounts and actual token supply in parallel
      const [largestAccounts, tokenSupplyResult] = await Promise.all([
        solana.execute(conn => conn.getTokenLargestAccounts(pubkey), RPC_CATEGORY.METADATA),
        solana.execute(conn => conn.getTokenSupply(pubkey), RPC_CATEGORY.METADATA),
      ]);

      const allAccounts = largestAccounts.value;
      if (!allAccounts || allAccounts.length === 0) {
        logger.debug(`No token accounts found for ${shortenAddress(mint)}`);
        return null;
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
        let filteredFunctionalCount = 0;
        const filteredAccounts = accounts.filter((acc) => {
          const isKnownSystem =
            excludedTokenAccounts.has(acc.addr) ||
            this._isLikelyFunctionalOwner(acc.owner, excludedOwners);

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
          filteredFunctionalCount,
        };
      };

      const tokenAgeMs = Math.max(0, Date.now() - (tokenTimestamp || Date.now()));
      const useFastPath = tokenAgeMs < 60000;

      // Fast path for fresh launches: still classify owners, but do it via batched account loads
      // so we can hide bonding/PDA/program-controlled wallets from "real holder" stats.
      if (useFastPath) {
        const {
          filteredAccounts,
          filteredBondingCurveBalance: bondingCurveBalance,
          filteredFunctionalCount,
        } = filterRealHolderAccounts(parsedTokenAccounts);

        const circulatingSupply = Math.max(0.0001, supply - bondingCurveBalance);
        const top10 = [...filteredAccounts]
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 10);
        const top10Total = top10.reduce((sum, acc) => sum + acc.amount, 0);
        const ownerBalances = new Map();
        for (const acc of filteredAccounts) {
          const ownerKey = acc.owner || acc.addr;
          ownerBalances.set(ownerKey, (ownerBalances.get(ownerKey) || 0) + acc.amount);
        }
        const top10OwnersTotal = [...ownerBalances.values()]
          .sort((a, b) => b - a)
          .slice(0, 10)
          .reduce((sum, amount) => sum + amount, 0);

        const preliminary = {
          supply,
          top10Percent: supply > 0 ? (top10Total / supply) * 100 : 0,
          top10CirculatingPercent: circulatingSupply > 0 ? (top10Total / circulatingSupply) * 100 : 0,
          top10OwnersPercent: supply > 0 ? (top10OwnersTotal / supply) * 100 : 0,
          top10OwnersCirculatingPercent: circulatingSupply > 0 ? (top10OwnersTotal / circulatingSupply) * 100 : 0,
          bundleHoldPercent: 0,
          earlyBuyerHoldPercent: 0,
          devHoldPercent: 0,
          circulatingSupply,
          bondingCurveBalance,
          realHolderCount: filteredAccounts.length,
          filteredFunctionalCount,
          axiomRouteAddress: bondingCurvePDA.toBase58(),
          topHolders: top10.map((t) => ({
            address: t.addr,
            owner: t.owner,
            percent: Math.min((t.amount / supply) * 100, 100),
          })),
          preliminary: true,
          dataInvalid: false,
        };

        this.holderStatsCache.set(mint, { data: preliminary, timestamp: Date.now() });
        return preliminary;
      }

      // === Separate bonding/system from holder accounts ===
      // Program-controlled / PDA-controlled wallets are not shown as real holders.
      let axiomRouteAddress = bondingCurvePDA.toBase58();
      const {
        filteredAccounts: filteredParsedAccounts,
        filteredBondingCurveBalance: bondingCurveBalance,
        filteredFunctionalCount,
      } = filterRealHolderAccounts(parsedTokenAccounts);

      // Circulating supply = total supply - bonding curve/system holdings
      const circulatingSupply = Math.max(0.0001, supply - bondingCurveBalance);

      logger.debug(`Holder stats for ${shortenAddress(mint)}: decimals=${tokenDecimals}, supply=${supply.toFixed(0)}, bondingCurve=${bondingCurveBalance.toFixed(0)}, circulating=${circulatingSupply.toFixed(0)}`);

      // === Sanity check: circulatingSupply must be positive and reasonable ===
      if (circulatingSupply <= 0) {
        logger.warn(`⚠️ Invalid circulatingSupply (${circulatingSupply.toFixed(0)}) for ${shortenAddress(mint)} — supply=${supply}, bondingCurve=${bondingCurveBalance}. Skipping holder stats.`);
        const invalid = {
          supply,
          top10Percent: 0,

          top10OwnersPercent: 0,
          bundleHoldPercent: 0,
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

      // Axiom style: exclude LP/bonding curve from holder LIST, but % is against TOTAL supply.
      const sortedAccounts = [...filteredParsedAccounts].sort((a, b) => b.amount - a.amount);
      const top10 = sortedAccounts.slice(0, 10);
      const top10Total = top10.reduce((sum, acc) => sum + acc.amount, 0);
      const top10Percent = supply > 0 ? (top10Total / supply) * 100 : 0;

      // Keep owner-level concentration as an internal secondary metric for deeper analysis.
      const ownerBalances = new Map();
      for (const acc of filteredParsedAccounts) {
        const ownerKey = acc.owner || acc.addr;
        ownerBalances.set(ownerKey, (ownerBalances.get(ownerKey) || 0) + acc.amount);
      }
      const top10OwnersTotal = [...ownerBalances.values()]
        .sort((a, b) => b - a)
        .slice(0, 10)
        .reduce((sum, amount) => sum + amount, 0);
      const top10OwnersPercent = supply > 0 ? (top10OwnersTotal / supply) * 100 : 0;

      // Sanity check: top10 over total supply should never exceed 100% materially.
      if (top10Percent > 100.5) {
        logger.warn(`⚠️ Invalid holder data for ${shortenAddress(mint)} — top10=${top10Percent.toFixed(1)}% of total supply, top10Total=${top10Total.toFixed(0)}, supply=${supply.toFixed(0)}.`);
        const invalid = {
          supply,
          top10Percent: 0,
          top10OwnersPercent: 0,
          bundleHoldPercent: 0,
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
      if (earlyBuyerWallets.length > 0) {
        const allAccountMap = new Map();
        for (const acc of parsedTokenAccounts) {
          allAccountMap.set(acc.addr, acc.amount);
        }

        let earlyBuyerTotal = 0;
        let bundleTotal = 0;
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
                  break;
                }
              } catch (e) { /* ignore */ }
            }
          } catch (e) { /* skip invalid address */ }
        }
        earlyBuyerHoldPercent = Math.min((earlyBuyerTotal / supply) * 100, 100);
        bundleHoldPercent = Math.min((bundleTotal / supply) * 100, 100);
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
          devHoldPercent = Math.min((devAccount.amount / supply) * 100, 100);
        }
      } catch (e) {
        logger.debug(`Could not derive dev ATA for ${shortenAddress(deployer)}: ${e.message}`);
      }

      const result = {
        supply,
        top10Percent,
        top10CirculatingPercent: circulatingSupply > 0 ? (top10Total / circulatingSupply) * 100 : 0,
        top10OwnersPercent,
        top10OwnersCirculatingPercent: circulatingSupply > 0 ? (top10OwnersTotal / circulatingSupply) * 100 : 0,
        bundleHoldPercent,
        earlyBuyerHoldPercent,
        devHoldPercent,
        circulatingSupply,
        bondingCurveBalance,
        realHolderCount: filteredParsedAccounts.length,
        filteredFunctionalCount,
        axiomRouteAddress,
        topHolders: top10.map(t => ({
          address: t.addr,
          owner: t.owner,
          percent: Math.min((t.amount / supply) * 100, 100),
        })),
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
   * Axiom-style bundle detection:
   * 1. Flag slot as bundle if >= 4 wallets buy in the same block
   * 2. Pattern filter: if a wallet's NEXT trade after the bundle is NOT also a bundle, discard it
   *    (Axiom: "If a wallet makes a buy as part of a detected bundle but its next transaction
   *     is not part of a bundle, it is disregarded from detection")
   */
  async _detectBundleWallets(earlyBuyerTrades) {
    if (!earlyBuyerTrades || earlyBuyerTrades.length < 4) return new Set();

    // Step 1: Resolve slots for all trades
    const tradesWithSlot = await Promise.all(earlyBuyerTrades.map(async (trade) => {
      if (trade.slot) return trade;
      if (!trade.signature) return { ...trade, slot: null };
      try {
        const parsed = await solana.executeRace(conn =>
          conn.getParsedTransaction(trade.signature, { maxSupportedTransactionVersion: 0 })
        );
        return { ...trade, slot: parsed?.slot || null };
      } catch (err) {
        logger.debug(`Failed to fetch slot for ${trade.signature}: ${err.message}`);
        return { ...trade, slot: null };
      }
    }));

    // Step 2: Build slot → traders map, identify bundle slots (>= 4 wallets)
    const slotMap = new Map();
    for (const trade of tradesWithSlot) {
      if (!trade.slot || !trade.trader) continue;
      if (!slotMap.has(trade.slot)) slotMap.set(trade.slot, []);
      slotMap.get(trade.slot).push(trade);
    }

    const bundleSlots = new Set();
    for (const [slot, trades] of slotMap.entries()) {
      const uniqueTraders = new Set(trades.map(t => t.trader));
      if (uniqueTraders.size >= 4) bundleSlots.add(slot);
    }

    if (bundleSlots.size === 0) return new Set();

    // Step 3: Collect bundle candidates (wallets in any bundle slot)
    const bundleCandidates = new Set();
    for (const slot of bundleSlots) {
      for (const trade of slotMap.get(slot)) {
        bundleCandidates.add(trade.trader);
      }
    }

    // Step 4: Pattern filter — build per-trader trade list sorted by slot
    const traderTrades = new Map();
    for (const trade of tradesWithSlot) {
      if (!trade.trader || !trade.slot) continue;
      if (!traderTrades.has(trade.trader)) traderTrades.set(trade.trader, []);
      traderTrades.get(trade.trader).push(trade);
    }
    for (const trades of traderTrades.values()) {
      trades.sort((a, b) => (a.slot || 0) - (b.slot || 0));
    }

    // Step 5: Apply pattern filter
    const bundleWallets = new Set();
    for (const trader of bundleCandidates) {
      const trades = traderTrades.get(trader) || [];

      // Find this trader's first bundle trade
      const bundleTradeIdx = trades.findIndex(t => bundleSlots.has(t.slot));
      if (bundleTradeIdx === -1) continue;

      // Check if there's a next trade after the bundle
      const nextTrade = trades[bundleTradeIdx + 1];
      if (!nextTrade) {
        // No subsequent trade in our data → cannot confirm pattern → keep (conservative)
        bundleWallets.add(trader);
      } else if (bundleSlots.has(nextTrade.slot)) {
        // Next trade is also in a bundle slot → confirmed consistent bundler
        bundleWallets.add(trader);
      }
      // else: next trade is NOT a bundle → pattern filter removes this wallet
    }

    logger.debug(`Bundle detection: ${bundleCandidates.size} candidates → ${bundleWallets.size} confirmed after pattern filter (${bundleSlots.size} bundle slots)`);
    return bundleWallets;
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
      return;
    }

    const buyers = earlyBuyers || [];
    const buyerCountAtStart = buyers.length; // Snapshot to detect new arrivals during analysis
    const requiredBuyers = settings.monitoring.earlyBuyersToMonitor;
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
      const [devAnalysis, buyerAnalyses, bundleWallets] = await Promise.all([
        // 1. Dev analysis (2-3 RPC calls) - ~2s, cached after first run
        tokenData._devAnalysis || devAnalyzer.analyzeDeployer(tokenData.deployer).then(result => {
          tokenData._devAnalysis = result; // Cache for subsequent re-scans
          return result;
        }),
        // 2. Wallet analysis (parallel batches) - ~12s
        walletAnalyzer.analyzeEarlyBuyers(buyerAddresses),
        // 3. Bundle wallet detection based on same-slot buys (Axiom-style approximation)
        this._detectBundleWallets(earlyBuyerTrades),
      ]);

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
        tokenData.timestamp
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

      // 7. Calculate bonding curve progress
      let bondingCurveProgress = tokenData.vSolInBondingCurve
        ? (tokenData.vSolInBondingCurve / 85) * 100 // PumpFun migrates at ~85 SOL
        : 0;

      // === Synchronize Market Cap calculation with Migration Check ===
      const solPrice = await priceService.getSolPrice() || 150;
      
      // If bonding curve is near completion (>80%) or token is older (>10m), try DexScreener for migrated price
      if (bondingCurveProgress > 80 || (Date.now() - tokenData.timestamp > 600000)) {
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
        settings,
      });

      // Log detailed rule results
      logger.info(`📋 Rules for ${tokenData.symbol} (${shortenAddress(mint)}):`);
      for (const r of ruleResult.results) {
        const icon = r.passed ? '✅' : '❌';
        logger.info(`  ${icon} [${r.ruleType}] ${r.ruleName}: ${r.reason}`);
      }
      logger.info(`  → ${ruleResult.summary}`);

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

        if (!this.passedTokens.has(mint) && ageMinutes < maxAge) {
          this._scheduleRecheck(
            mint,
            5000,
            ruleResult.onlyRetryableFailed
              ? 'chỉ còn điều kiện retryable chưa đạt'
              : 'chưa đạt điều kiện nhưng vẫn còn trong tuổi cho phép'
          );
        } else {
          this._clearPendingRecheck(mint);
          logger.info(`❌ ${tokenData.symbol}: ${ruleResult.summary} (Ngưng quét, tuổi: ${ageMinutes.toFixed(1)}m)`);
        }
      }
    } catch (err) {
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
      this._scheduleRecheck(mint, 8000, 'gặp lỗi phân tích tạm thời');
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
   * Start 1-minute timer to check for timed-out tokens
   */
  _startCleanupTimer() {
    setInterval(() => {
      this._cleanupOldTokens();
    }, 60000); // Check every minute
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
        
        // Record as detailed FAIL
        tracker.recordScan({
          mint,
          tokenName: token.name,
          tokenSymbol: token.symbol,
          deployer: token.deployer,
          ruleResult: {
            shouldBuy: false,
            summary: `Bị loại: Không đủ ${settings.monitoring.earlyBuyersToMonitor} ví mua sớm trong 5 phút.`,
            results: [
              { ruleId: 'preliminary_buyers', ruleName: 'Ví mua sớm', ruleType: 'PRE-SCAN', passed: false, reason: `Chỉ có ${buyers.length}/${settings.monitoring.earlyBuyersToMonitor} ví mua trong thời gian theo dõi.` },
              { ruleId: 'preliminary_timeout', ruleName: 'Thời gian chờ', ruleType: 'PRE-SCAN', passed: false, reason: `Quá hạn theo dõi (${Math.floor(durationMs/60000)} phút).` }
            ]
          },
          actionTaken: 'BLOCKED',
          timestamp: Date.now()
        });

        // Mark as analyzed so we don't process it again
        this.analyzedTokens.add(mint);
        
        // Clean up memory
        this.tokenData.delete(mint);
        this.tokenEarlyBuyers.delete(mint);
        this.tokenGlobalFees.delete(mint);
        this.holderStatsCache.delete(mint);
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
        this.passedTokens.delete(mint);
        this.analyzedTokens.delete(mint);
        this.processingTokens.delete(mint);
        this.holderStatsCache.delete(mint);
        detector.unsubscribeFromToken(mint);
      }
    }
  }

  /**
   * Graceful shutdown
   */
  async stop() {
    logger.info('Shutting down...');
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
