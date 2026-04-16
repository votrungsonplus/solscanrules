const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const logger = require('../utils/logger');
const ruleEngine = require('../engine/rule-engine');
const settings = require('../config/settings');
const tracker = require('../tracker/trade-tracker');
const priceService = require('../services/price-service');
const sellExecutor = require('../executor/sell-executor');
const { SolanaConnection: solana } = require('../core/solana-connection');
const {
  applyRuleProfile,
  getRuleProfiles,
  markProfileAsCustom,
  persistAppliedRuleProfile,
} = require('../engine/rule-profiles');
const { syncToEnv, getComparisonTable } = require('../config/env-sync');

class WebServer {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new Server(this.server);
    this.port = process.env.WEB_PORT || 3000;
    this._lastAnalysisResults = new Map(); // Cache last 50 analyses for quick lookup
  }

  start() {
    this.app.use(express.static(path.join(__dirname, 'public')));

    const safeParseJson = (value, fallback = null) => {
      if (!value || typeof value !== 'string') return fallback;
      try {
        return JSON.parse(value);
      } catch (err) {
        return fallback;
      }
    };

    const buildAnalysisFromScan = (scan, overrides = {}) => {
      if (!scan) return null;

      const parsedRuleResult = safeParseJson(scan.rule_result, null);
      const ruleResult = parsedRuleResult || {
        shouldBuy: String(scan.rule_result || '').includes('PASS'),
        summary: scan.rule_result || 'No rule result',
        results: [],
        isLegacy: true,
      };

      return {
        tokenData: {
          mint: scan.mint,
          name: scan.token_name,
          symbol: scan.token_symbol,
          deployer: scan.deployer,
          timestamp: scan.timestamp,
          marketCapSol: scan.market_cap_sol, // From the new DB column
          ...overrides.tokenData,
        },
        ruleResult: overrides.ruleResult || ruleResult,
        devRiskScore: scan.dev_risk_score,
        tokenScore: safeParseJson(scan.token_score_json, null) ?? scan.token_score,
        devAnalysis: safeParseJson(scan.dev_analysis_json, null),
        holderStats: safeParseJson(scan.holder_stats_json, null),
        clusterAnalysis: safeParseJson(scan.cluster_analysis_json, null),
        earlyBuyers: safeParseJson(scan.early_buyers_json, null),
        earlyBuyerTrades: safeParseJson(scan.early_buyer_trades_json, null),
        retryCount: tracker.getScanCount(scan.mint),
        isFinal: scan.is_final === 1,
        ...overrides.root,
      };
    };

    const buildBotStatusPayload = async () => ({
      autoBuyEnabled: settings.trading.autoBuyEnabled,
      autoSellEnabled: settings.trading.autoSellEnabled,
      buyAmountSol: settings.trading.buyAmountSol,
      takeProfitPercent: settings.risk.takeProfitPercent,
      stopLossPercent: settings.risk.stopLossPercent,
      maxPositions: settings.trading.maxConcurrentPositions,
      dailyLossLimitSol: settings.trading.dailyLossLimitSol,
      earlyBuyersToMonitor: settings.monitoring.earlyBuyersToMonitor,
      minBuyersToPass: settings.monitoring.minBuyersToPass,
      showAllEarlyBuyers: settings.monitoring.showAllEarlyBuyers,
      buySlippage: settings.trading.buySlippage,
      sellSlippage: settings.trading.sellSlippage,
      activeRuleProfile: ruleEngine.getActiveProfile(),
      realWallet: await solana.getWalletSummary(),
    });

    // API Endpoints
    this.app.get('/api/rules', (req, res) => {
      res.json(ruleEngine.getRules());
    });

    this.app.get('/api/status', (req, res) => {
      res.json({
        autoBuyEnabled: settings.trading.autoBuyEnabled,
        autoSellEnabled: settings.trading.autoSellEnabled,
        buyAmountSol: settings.trading.buyAmountSol,
        takeProfitPercent: settings.risk.takeProfitPercent,
        stopLossPercent: settings.risk.stopLossPercent,
        maxPositions: settings.trading.maxConcurrentPositions,
        dailyLossLimitSol: settings.trading.dailyLossLimitSol,
        earlyBuyersToMonitor: settings.monitoring.earlyBuyersToMonitor,
        minBuyersToPass: settings.monitoring.minBuyersToPass,
        showAllEarlyBuyers: settings.monitoring.showAllEarlyBuyers,
        buySlippage: settings.trading.buySlippage,
        sellSlippage: settings.trading.sellSlippage,
        activeRuleProfile: ruleEngine.getActiveProfile(),
      });
    });

    this.app.get('/api/rule-profiles', (req, res) => {
      res.json({
        activeRuleProfile: ruleEngine.getActiveProfile(),
        profiles: getRuleProfiles(),
      });
    });

    this.app.get('/api/stats', (req, res) => {
      res.json(tracker.getTodayStats());
    });

    this.app.get('/api/trades', (req, res) => {
      const limit = parseInt(req.query.limit) || 20;
      res.json(tracker.getTradeHistory(limit));
    });

    this.app.get('/api/passed', (req, res) => {
      res.json(tracker.getPassedTokens24h());
    });

    this.app.get('/api/winrate', (req, res) => {
      res.json(tracker.getWinRateStats());
    });

    // ENV-SYNC: So sánh .env ↔ settings đang chạy
    this.app.get('/api/env-status', (req, res) => {
      res.json(getComparisonTable(settings, ruleEngine));
    });

    // Socket.IO connections
    this.io.on('connection', async (socket) => {
      logger.info('Web client connected');

      const emitPassedTokenInfo = async (mint, options = {}) => {
        const { refreshMarketData = false } = options;
        const passedToken = tracker.getPassedTokenByMint(mint);
        const scan = tracker.getScanForMint(mint);

        if (!passedToken) {
          return false;
        }

        let launchMcapUsd = passedToken.launch_mcap_usd || 0;
        let highestMcapUsd = passedToken.highest_mcap_usd || launchMcapUsd;
        let highestMcapTimestamp = passedToken.highest_mcap_timestamp || null;
        let currentMcapUsd = passedToken.current_mcap_usd || highestMcapUsd || launchMcapUsd;
        let currentVolumeSol = 0;
        let currentGlobalFee = 0;
        let refreshedAt = null;
        let pairAddress = null;
        let symbol = passedToken.symbol || scan?.token_symbol || '???';
        let name = scan?.token_name || 'Unknown';
        let launchMcapSol = passedToken.launch_mcap_sol || 0;
        let highestMcapSol = passedToken.highest_mcap_sol || launchMcapSol;
        let currentMcapSol = passedToken.current_mcap_sol || highestMcapSol || launchMcapSol;
        let holderStats = null;
        let hasFreshMarketData = false;
        const storedAnalysis = buildAnalysisFromScan(scan);

        if (refreshMarketData) {
          const orchestrator = require('../core/orchestrator');
          try {
            const [pairs, holders] = await Promise.all([
              priceService.getTokensData([mint]),
              orchestrator._fetchTokenHolders(mint, scan?.deployer || passedToken.deployer || '')
            ]);
            
            holderStats = holders;
            const pair = priceService.selectBestPairForMint(pairs, mint) || pairs[0];

            if (pair) {
              currentMcapUsd = parseFloat(pair.marketCap || pair.fdv || 0);
              const volumeUsd = parseFloat(pair.volume?.h24 || pair.volume?.h6 || pair.volume?.h1 || 0);
              const solPrice = await priceService.getSolPrice() || 150;
              currentVolumeSol = solPrice > 0 ? volumeUsd / solPrice : 0;
              currentGlobalFee = currentVolumeSol / 100;
              refreshedAt = Date.now();
              pairAddress = pair.pairAddress || null;
              symbol = pair.baseToken?.symbol || symbol;
              name = pair.baseToken?.name || name;
              hasFreshMarketData = currentMcapUsd > 0;

              if (currentMcapUsd > 0) {
                currentMcapSol = currentVolumeSol * 100; // rough approximation if needed, or better:
                currentMcapSol = currentMcapUsd / (solPrice || 150);
                
                tracker.updateCurrentMcap(mint, currentMcapUsd, currentMcapSol);
                if (currentMcapUsd > highestMcapUsd) {
                  highestMcapUsd = currentMcapUsd;
                  highestMcapSol = currentMcapSol;
                  highestMcapTimestamp = Date.now();
                  tracker.updateHighestMcap(mint, highestMcapUsd, highestMcapTimestamp, highestMcapSol);
                }
              }
            }
          } catch (err) {
            logger.error(`Error refreshing passed token market data for ${mint}: ${err.message}`);
          }
        }

        const mergedTokenData = {
          mint,
          name,
          symbol,
          deployer: scan?.deployer || '',
          timestamp: passedToken.timestamp || scan?.timestamp,
          marketCapUsd: currentMcapUsd || highestMcapUsd || launchMcapUsd || 0,
          circulatingMcapUsd: currentMcapUsd || highestMcapUsd || launchMcapUsd || 0,
          launchMcapUsd,
          launchMcapSol,
          highestMcapUsd: highestMcapUsd || launchMcapUsd || 0,
          highestMcapSol,
          highestMcapTimestamp,
          currentMcapUsd: currentMcapUsd || highestMcapUsd || launchMcapUsd || 0,
          currentMcapSol,
          volume: currentVolumeSol,
          globalFee: currentGlobalFee,
          refreshedAt,
          axiomRouteAddress: pairAddress || storedAnalysis?.tokenData?.axiomRouteAddress || mint,
        };

        if (storedAnalysis) {
          socket.emit('analysisResult', {
            ...storedAnalysis,
            tokenData: {
              ...storedAnalysis.tokenData,
              ...mergedTokenData,
            },
            holderStats: holderStats || storedAnalysis.holderStats,
          });
        } else {
          socket.emit('analysisResult', {
            infoOnly: true,
            tokenData: mergedTokenData,
            holderStats,
            ruleResult: {
              shouldBuy: true,
              summary: 'Passed token info',
              results: []
            }
          });
        }

        if (refreshMarketData) {
          this.io.emit('passedTokensUpdate', tracker.getPassedTokens24h());
          this.io.emit('topPnLUpdate', tracker.getTopPnLTokens('24h'));
          this.io.emit('winRateUpdate', tracker.getWinRateStats());
        }

        return refreshMarketData ? hasFreshMarketData : true;
      };

      // Send initial data for persistence across reloads
      socket.emit('rulesList', ruleEngine.getRules());
      socket.emit('ruleProfiles', {
        activeRuleProfile: ruleEngine.getActiveProfile(),
        profiles: getRuleProfiles(),
      });
      socket.emit('passedTokensUpdate', tracker.getPassedTokens24h());
      socket.emit('topPnLUpdate', tracker.getTopPnLTokens('24h'));
      socket.emit('winRateUpdate', tracker.getWinRateStats());

      const latestDetected = tracker.getRecentDetectedTokens(500);
      socket.emit('initialFeed', latestDetected);
      
      const latestScans = tracker.getRecentScans(100);
      socket.emit('initialScans', latestScans.map((scan) => ({
        ...scan,
        _analysisResult: buildAnalysisFromScan(scan),
      })));

      const currentPrice = await priceService.getSolPrice();
      socket.emit('solPriceUpdate', currentPrice);

      // Send current bot settings
      socket.emit('botStatus', await buildBotStatusPayload());

      // Send today's stats
      socket.emit('dailyStats', tracker.getTodayStats());

      // Send trade history
      socket.emit('tradeHistory', tracker.getTradeHistory(20));
      socket.emit('realWalletUpdate', await solana.getWalletSummary());
      socket.emit('realPositionsUpdate', sellExecutor.getPositions());

      // Toggle rule
      socket.on('toggleRule', (data) => {
        const { ruleId, enabled } = data;
        ruleEngine.toggleRule(ruleId, enabled);
        tracker.saveRuleState(ruleId, enabled);
        markProfileAsCustom(tracker, ruleEngine);
        this.io.emit('rulesList', ruleEngine.getRules());
        this.io.emit('ruleProfiles', {
          activeRuleProfile: ruleEngine.getActiveProfile(),
          profiles: getRuleProfiles(),
        });
        syncToEnv(settings, ruleEngine);
        logger.info(`Web action: Rule ${ruleId} set to ${enabled} (Saved to DB + .env)`);
      });

      // Update rule parameter (e.g., minMarketCapSol, maxPercent, etc.)
      socket.on('updateRuleParam', (data) => {
        const { ruleId, param, value } = data;
        if (!ruleId || !param) return;
        const val = parseFloat(value);
        if (isNaN(val)) return;
        ruleEngine.updateRule(ruleId, { [param]: val });
        tracker.saveBotSetting(`rule_${ruleId}_${param}`, val);
        markProfileAsCustom(tracker, ruleEngine);
        this.io.emit('rulesList', ruleEngine.getRules());
        this.io.emit('ruleProfiles', {
          activeRuleProfile: ruleEngine.getActiveProfile(),
          profiles: getRuleProfiles(),
        });
        syncToEnv(settings, ruleEngine);
        logger.info(`Web action: Rule ${ruleId}.${param} = ${val} (Saved to DB + .env)`);
      });

      socket.on('applyRuleProfile', async (profileId) => {
        try {
          const profile = applyRuleProfile(ruleEngine, profileId);
          persistAppliedRuleProfile(tracker, ruleEngine, profile.id);
          this.io.emit('rulesList', ruleEngine.getRules());
          this.io.emit('ruleProfiles', {
            activeRuleProfile: ruleEngine.getActiveProfile(),
            profiles: getRuleProfiles(),
          });
          this.io.emit('botStatus', await buildBotStatusPayload());
          syncToEnv(settings, ruleEngine);
          logger.info(`Web action: Applied rule profile ${profile.id} (Saved to DB + .env)`);
        } catch (err) {
          logger.warn(`Failed to apply rule profile ${profileId}: ${err.message}`);
        }
      });

      // Update auto-buy
      socket.on('updateAutoBuy', async (enabled) => {
        settings.trading.autoBuyEnabled = enabled;
        tracker.saveBotSetting('autoBuyEnabled', enabled);
        this.io.emit('botStatus', await buildBotStatusPayload());
        syncToEnv(settings, ruleEngine);
        logger.info(`Web action: Auto-Buy set to ${enabled} (Saved to DB + .env)`);
      });

      // Update auto-sell
      socket.on('updateAutoSell', async (enabled) => {
        settings.trading.autoSellEnabled = enabled;
        tracker.saveBotSetting('autoSellEnabled', enabled);
        this.io.emit('botStatus', await buildBotStatusPayload());
        syncToEnv(settings, ruleEngine);
        logger.info(`Web action: Auto-Sell set to ${enabled} (Saved to DB + .env)`);
      });

      // Update buy amount
      socket.on('updateBuyAmount', async (amount) => {
        const val = parseFloat(amount);
        if (!isNaN(val) && val > 0) {
          settings.trading.buyAmountSol = val;
          tracker.saveBotSetting('buyAmountSol', val);
          this.io.emit('botStatus', await buildBotStatusPayload());
          syncToEnv(settings, ruleEngine);
          logger.info(`Web action: Buy Amount set to ${val} SOL (Saved to DB + .env)`);
        }
      });

      socket.on('updateTradingSetting', async (data) => {
        const { key, value } = data || {};
        const val = parseFloat(value);
        if (!key || isNaN(val)) return;

        switch (key) {
          case 'takeProfitPercent':
            if (val <= 0) return;
            settings.risk.takeProfitPercent = val;
            tracker.saveBotSetting('takeProfitPercent', val);
            break;
          case 'stopLossPercent':
            if (val <= 0) return;
            settings.risk.stopLossPercent = val;
            tracker.saveBotSetting('stopLossPercent', val);
            break;
          case 'maxConcurrentPositions':
            if (val < 1) return;
            settings.trading.maxConcurrentPositions = Math.round(val);
            tracker.saveBotSetting('maxConcurrentPositions', settings.trading.maxConcurrentPositions);
            break;
          case 'dailyLossLimitSol':
            if (val < 0) return;
            settings.trading.dailyLossLimitSol = val;
            tracker.saveBotSetting('dailyLossLimitSol', val);
            break;
          case 'earlyBuyersToMonitor':
            if (val < 1 || val > 20) return;
            settings.monitoring.earlyBuyersToMonitor = Math.round(val);
            tracker.saveBotSetting('earlyBuyersToMonitor', settings.monitoring.earlyBuyersToMonitor);
            markProfileAsCustom(tracker, ruleEngine);
            break;
          case 'minBuyersToPass':
            if (val < 1 || val > 20) return;
            settings.monitoring.minBuyersToPass = Math.round(val);
            tracker.saveBotSetting('minBuyersToPass', settings.monitoring.minBuyersToPass);
            markProfileAsCustom(tracker, ruleEngine);
            break;
          case 'showAllEarlyBuyers':
            settings.monitoring.showAllEarlyBuyers = value === 'true' || value === true;
            tracker.saveBotSetting('showAllEarlyBuyers', settings.monitoring.showAllEarlyBuyers);
            markProfileAsCustom(tracker, ruleEngine);
            break;
          case 'buySlippage':
            if (val < 1 || val > 100) return;
            settings.trading.buySlippage = Math.round(val);
            tracker.saveBotSetting('buySlippage', settings.trading.buySlippage);
            break;
          case 'sellSlippage':
            if (val < 1 || val > 100) return;
            settings.trading.sellSlippage = Math.round(val);
            tracker.saveBotSetting('sellSlippage', settings.trading.sellSlippage);
            break;
          default:
            return;
        }

        this.io.emit('botStatus', await buildBotStatusPayload());
        this.io.emit('ruleProfiles', {
          activeRuleProfile: ruleEngine.getActiveProfile(),
          profiles: getRuleProfiles(),
        });
        syncToEnv(settings, ruleEngine);
        logger.info(`Web action: ${key} = ${val} (Saved to DB + .env)`);
      });

      // Get analysis for a specific token
      socket.on('getAnalysis', async (request) => {
        const mint = typeof request === 'string' ? request : request?.mint;
        const mode = typeof request === 'object' ? request?.mode : null;
        if (!mint) return;

        if (mode === 'passed-info') {
          const emitted = await emitPassedTokenInfo(mint);
          if (emitted) {
            return;
          }
        }

        // Check in-memory cache first (recent live analyses)
        const cached = this._lastAnalysisResults.get(mint);
        if (cached) {
          socket.emit('analysisResult', cached);
          return;
        }

        // Fallback to DB
        let scan = tracker.getScanForMint(mint);
        if (scan) {
          const analysis = buildAnalysisFromScan(scan);
          if (analysis) {
            socket.emit('analysisResult', analysis);
          } else {
            logger.error(`Error rebuilding historical analysis for ${mint}`);
          }
        } else {
          const detected = tracker.getDetectedTokenByMint(mint);
          if (detected) {
            // Check if token is currently being analyzed or waiting for buyers
            const orchestrator = require('../core/orchestrator');
            const isProcessing = orchestrator.processingTokens?.has(mint);
            const buyers = orchestrator.tokenEarlyBuyers?.get(mint);
            const buyerCount = buyers ? buyers.length : 0;
            const required = settings.monitoring.earlyBuyersToMonitor;

            let summary;
            if (isProcessing) {
              summary = `⏳ Đang phân tích... (${buyerCount}/${required} buyers)`;
            } else if (buyerCount > 0) {
              summary = `🔄 Chờ phân tích tiếp (${buyerCount}/${required} buyers)`;
            } else {
              const ageMs = Date.now() - detected.timestamp;
              const ageMin = (ageMs / 60000).toFixed(1);
              summary = `⏳ Đang chờ giao dịch đầu tiên (${ageMin}m)`;
            }

            socket.emit('analysisResult', {
              tokenData: {
                mint: detected.mint,
                name: detected.name,
                symbol: detected.symbol,
                timestamp: detected.timestamp
              },
              ruleResult: {
                shouldBuy: false,
                summary,
                results: []
              }
            });
          }
        }
      });

      // Manual refresh
      socket.on('manualRefresh', (mint) => {
        const orchestrator = require('../core/orchestrator');
        orchestrator.manualTokenRefresh(mint);
        logger.info(`Web action: Manual refresh requested for ${mint}`);
      });

      socket.on('refreshPassedTokenInfo', async (mint) => {
        logger.info(`Web action: Update Status requested for ${mint}`);
        try {
          const orchestrator = require('../core/orchestrator');
          
          // Trigger the robust revival pipeline
          // This will fetch market data, recover deployer on-chain, 
          // recover buyers on-chain, and run full analysis.
          orchestrator.manualTokenRefresh(mint);

          socket.emit('refreshPassedTokenInfoStatus', { success: true, message: 'Status recovery triggered. Please wait 10-20s.' });
          logger.info(`Update Status recovery triggered for ${mint}`);
        } catch (err) {
          logger.error(`Update Status failed for ${mint}: ${err.message}`);
          socket.emit('refreshPassedTokenInfoStatus', { success: false, message: err.message });
        }
      });

      // Refresh all PnL for tokens passed in 24h
      socket.on('refreshAllPnL', async () => {
        try {
          logger.info('Web action: Refreshing PnL for ALL passed tokens...');
          const passedTokens = tracker.getAllPassedTokens();
          const mints = passedTokens.map(t => t.mint);
          
          if (mints.length === 0) {
            socket.emit('refreshPnLStatus', { success: true, message: 'No tokens to refresh' });
            return;
          }

          // Fetch fresh data from DexScreener
          const pairs = await priceService.getTokensData(mints);
          
          let updateCount = 0;
          const solPrice = await priceService.getSolPrice() || 150;

          for (const pair of pairs) {
            const mint = pair.baseToken.address;
            const mcapUsd = parseFloat(pair.fdv || pair.marketCap || 0);
            if (mcapUsd > 0) {
              const mcapSol = mcapUsd / solPrice;
              // Always update current mcap for informational display
              tracker.updateCurrentMcap(mint, mcapUsd, mcapSol);
              // ONLY update highest if new price is HIGHER — PnL never goes down
              tracker.updateHighestMcap(mint, mcapUsd, Date.now(), mcapSol); // updateHighestMcap has WHERE highest < ? guard
              updateCount++;
            }
          }

          logger.info(`PnL Refresh complete: Updated ${updateCount} tokens`);
          
          // Broadcast updates
          this.io.emit('passedTokensUpdate', tracker.getPassedTokens24h());
          this.io.emit('topPnLUpdate', tracker.getTopPnLTokens('24h'));
          this.io.emit('winRateUpdate', tracker.getWinRateStats());
          socket.emit('refreshPnLStatus', { success: true, message: `Updated ${updateCount} tokens` });
        } catch (err) {
          logger.error(`PnL Refresh failed: ${err.message}`);
          socket.emit('refreshPnLStatus', { success: false, message: err.message });
        }
      });

      socket.on('manualSyncWallet', async () => {
        const orchestrator = require('../core/orchestrator');
        await orchestrator._syncWebData();
      });

      socket.on('manualSyncPositions', async () => {
        const orchestrator = require('../core/orchestrator');
        await orchestrator._syncWebData();
      });

      socket.on('requestTop10', (period) => {
        const limit = 20;
        const validPeriod = period === 'all' ? 'all' : '24h';
        socket.emit('topPnLUpdate', tracker.getTopPnLTokens(validPeriod, limit));
      });

      socket.on('disconnect', () => {
        logger.info('Web client disconnected');
      });
    });

    this.server.listen(this.port, () => {
      logger.info(`Web Server running at http://localhost:${this.port}`);
    });
  }

  // Emits a real-time event to the dashboard
  emit(eventName, data) {
    if (this.io) {
      this.io.emit(eventName, data);

      // Cache analysis results for quick lookup
      if (eventName === 'analysisResult' && data?.tokenData?.mint) {
        this._lastAnalysisResults.set(data.tokenData.mint, data);
        // Keep cache at max 50
        if (this._lastAnalysisResults.size > 50) {
          const firstKey = this._lastAnalysisResults.keys().next().value;
          this._lastAnalysisResults.delete(firstKey);
        }
      }
    }
  }
}

module.exports = new WebServer();
