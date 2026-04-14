const priceService = require('./price-service');
const tracker = require('../tracker/trade-tracker');
const webServer = require('../web/server');
const logger = require('../utils/logger');

class MonitorService {
  constructor() {
    this.fastInterval = null;
    this.slowInterval = null;
    this.fastIntervalMs = 15000; // 15 seconds for hot tokens (<= 1 hour)
    this.slowIntervalMs = 60000; // 1 minute for old tokens (> 1 hour)
  }

  start() {
    if (this.fastInterval || this.slowInterval) return;
    
    logger.info('ATH Monitor Service started (Dual-tier: 15s / 1m)');
    this.fastInterval = setInterval(() => this.checkATH('fast'), this.fastIntervalMs);
    this.slowInterval = setInterval(() => this.checkATH('slow'), this.slowIntervalMs);
    
    // Run once immediately
    this.checkATH('all');
  }

  stop() {
    if (this.fastInterval) clearInterval(this.fastInterval);
    if (this.slowInterval) clearInterval(this.slowInterval);
    this.fastInterval = null;
    this.slowInterval = null;
  }

  async checkATH(mode = 'all') {
    try {
      const solPrice = await priceService.getSolPrice() || 150;
      if (mode === 'slow' || mode === 'all') {
        webServer.emit('solPriceUpdate', solPrice);
      }

      const allTokens = tracker.getPassedTokens24h();
      if (allTokens.length === 0) return;

      const now = Date.now();
      const oneHourMs = 60 * 60 * 1000;

      let targetTokens = [];
      if (mode === 'all') {
        targetTokens = allTokens;
      } else if (mode === 'fast') {
        targetTokens = allTokens.filter(t => (now - t.timestamp) <= oneHourMs);
      } else if (mode === 'slow') {
        targetTokens = allTokens.filter(t => (now - t.timestamp) > oneHourMs);
      }

      if (targetTokens.length === 0) return;

      // Group into chunks of 30 for Dexscreener requests
      const chunkSize = 30;
      for (let i = 0; i < targetTokens.length; i += chunkSize) {
        const chunk = targetTokens.slice(i, i + chunkSize);
        const mints = chunk.map(t => t.mint);
        const pairs = await priceService.getTokensData(mints);

        if (!pairs || pairs.length === 0) continue;

        for (const token of chunk) {
          const relevantPairs = pairs.filter(p => p.baseToken.address === token.mint);
          if (relevantPairs.length === 0) continue;

          const currentMcapUsd = parseFloat(relevantPairs[0].fdv || relevantPairs[0].marketCap || 0);
          const currentMcapSol = solPrice > 0 ? currentMcapUsd / solPrice : 0;
          
          if (currentMcapUsd > 0) {
            tracker.updateCurrentMcap(token.mint, currentMcapUsd, currentMcapSol);
            
            if (currentMcapUsd > (token.highest_mcap_usd || 0)) {
              tracker.updateHighestMcap(token.mint, currentMcapUsd, Date.now(), currentMcapSol);
              logger.debug(`ATH Update [${mode}]: ${token.symbol} hit new ATH of $${formatNumber(currentMcapUsd)}`);
            }
          }
        }
      }

      const updatedTokens = tracker.getPassedTokens24h();
      webServer.emit('passedTokensUpdate', updatedTokens);
      webServer.emit('topPnLUpdate', tracker.getTopPnLTokens('24h'));

    } catch (err) {
      logger.error(`ATH Check failed (${mode}): ${err.message}`);
    }
  }
}

// Simple formatNumber helper
function formatNumber(num) {
    if (!num || num === 0) return '0';
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
    return num.toFixed(0);
}

module.exports = new MonitorService();
