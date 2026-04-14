const axios = require('axios');
const logger = require('../utils/logger');

class PriceService {
  constructor() {
    this.solPrice = 150; // Default fallback
    this.lastSolPriceUpdate = 0;
    this.updateInterval = 60000; // 1 minute
  }

  async getSolPrice() {
    const now = Date.now();
    if (now - this.lastSolPriceUpdate > this.updateInterval) {
      try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
        if (response.data && response.data.price) {
          this.solPrice = parseFloat(response.data.price);
          this.lastSolPriceUpdate = now;
          logger.info(`SOL Price updated from Binance: $${this.solPrice.toFixed(2)}`);
        }
      } catch (err) {
        logger.error(`Failed to fetch SOL price from Binance: ${err.message}`);
      }
    }
    return this.solPrice;
  }

  async getTokensData(mints) {
    if (!mints || mints.length === 0) return [];
    try {
      // DexScreener supports up to 30 addresses per request
      const chunks = [];
      for (let i = 0; i < mints.length; i += 30) {
        chunks.push(mints.slice(i, i + 30).join(','));
      }

      let allPairs = [];
      for (const chunk of chunks) {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk}`);
        if (response.data && response.data.pairs) {
          allPairs = allPairs.concat(response.data.pairs);
        }
        // Small delay to respect rate limits if there are multiple chunks
        if (chunks.length > 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      return allPairs;
    } catch (err) {
      logger.error(`Failed to fetch from DexScreener: ${err.message}`);
      return [];
    }
  }

  /**
   * Choose the most relevant live liquidity pool for a mint.
   * Prefer highest USD liquidity, then highest recent volume.
   */
  selectBestPairForMint(pairs, mint) {
    if (!pairs || pairs.length === 0 || !mint) return null;

    const relevantPairs = pairs.filter((p) => p?.baseToken?.address === mint);
    if (relevantPairs.length === 0) return null;

    relevantPairs.sort((a, b) => {
      const liqA = parseFloat(a?.liquidity?.usd || 0);
      const liqB = parseFloat(b?.liquidity?.usd || 0);
      if (liqB !== liqA) return liqB - liqA;

      const volA = parseFloat(a?.volume?.h24 || a?.volume?.h6 || a?.volume?.h1 || 0);
      const volB = parseFloat(b?.volume?.h24 || b?.volume?.h6 || b?.volume?.h1 || 0);
      return volB - volA;
    });

    return relevantPairs[0];
  }
}

module.exports = new PriceService();
