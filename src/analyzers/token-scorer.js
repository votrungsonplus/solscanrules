const axios = require('axios');
const logger = require('../utils/logger');

class TokenScorer {
  constructor() {
    this._uriCache = new Map(); // uri -> score (persistent per-process)
    this._uriCacheMaxSize = 2000;
  }

  /**
   * Score token metadata quality (0-100)
   * Higher score = more likely legitimate project
   * @param {object} tokenData - Token metadata
   * @param {object} [devAnalysis] - Result from DevAnalyzer.analyzeDeployer()
   * @param {object[]} [earlyBuyers] - Result from WalletAnalyzer.analyzeEarlyBuyers()
   */
  async scoreToken(tokenData, devAnalysis = null, earlyBuyers = null) {
    const scores = {
      metadata: this._scoreMetadata(tokenData),
      bondingCurve: this._scoreBondingCurve(tokenData),
      deployer: devAnalysis ? this._scoreDeployer(devAnalysis) : 0,
      earlyBuyers: earlyBuyers ? this._scoreEarlyBuyers(earlyBuyers) : 0,
    };

    // Fetch and score URI metadata if available (cached — IPFS is slow + immutable)
    if (tokenData.uri) {
      scores.metadata += await this._scoreUriMetadataCached(tokenData.uri);
    }

    const totalScore = Math.min(
      Math.round(
        scores.metadata * 0.25 +
        scores.bondingCurve * 0.25 +
        scores.deployer * 0.25 +
        scores.earlyBuyers * 0.25
      ),
      100
    );

    return {
      totalScore,
      breakdown: scores,
      verdict: totalScore >= 70 ? 'STRONG' : totalScore >= 45 ? 'MODERATE' : 'WEAK',
    };
  }

  /**
   * Score basic token metadata
   */
  _scoreMetadata(tokenData) {
    let score = 0;

    // Has a name
    if (tokenData.name && tokenData.name !== 'Unknown' && tokenData.name.length > 1) {
      score += 15;
    }

    // Has a symbol
    if (tokenData.symbol && tokenData.symbol !== 'UNKNOWN' && tokenData.symbol.length >= 2) {
      score += 15;
    }

    // Has URI (metadata link)
    if (tokenData.uri) {
      score += 20;
    }

    // Name length reasonable (not spam-like)
    if (tokenData.name && tokenData.name.length >= 3 && tokenData.name.length <= 30) {
      score += 10;
    }

    return Math.min(score, 60);
  }

  /**
   * Score bonding curve status
   */
  _scoreBondingCurve(tokenData) {
    let score = 50; // Base score

    // Has initial buy from deployer (skin in the game)
    if (tokenData.solAmount > 0) {
      score += 10;
    }

    // Reasonable initial market cap
    if (tokenData.marketCapSol > 0 && tokenData.marketCapSol < 100) {
      score += 15;
    }

    // Has bonding curve data
    if (tokenData.bondingCurveKey) {
      score += 10;
    }

    return Math.min(score, 85);
  }

  /**
   * Score deployer quality based on DevAnalyzer results (0-100)
   * Higher = safer deployer
   */
  _scoreDeployer(devAnalysis) {
    let score = 50; // Start neutral

    // Low risk score from DevAnalyzer = good deployer
    if (devAnalysis.riskScore <= 20) score += 30;
    else if (devAnalysis.riskScore <= 40) score += 15;
    else if (devAnalysis.riskScore >= 70) score -= 30;
    else if (devAnalysis.riskScore >= 50) score -= 15;

    // Wallet age bonus
    if (devAnalysis.walletAge >= 30) score += 10;
    else if (devAnalysis.walletAge >= 7) score += 5;
    else if (devAnalysis.walletAge < 1) score -= 10;

    // No rug history = good
    if (devAnalysis.rugPullCount === 0 && devAnalysis.tokensDeployed > 0) score += 10;
    // Has rug history = bad
    if (devAnalysis.rugPullRatio > 0.3) score -= 20;

    // Not a serial deployer
    if (devAnalysis.tokensDeployed <= 2) score += 5;

    return Math.max(0, Math.min(score, 100));
  }

  /**
   * Score early buyer quality based on WalletAnalyzer results (0-100)
   * Higher = more organic-looking buyers
   */
  _scoreEarlyBuyers(earlyBuyers) {
    if (!earlyBuyers || earlyBuyers.length === 0) return 0;

    let score = 50; // Start neutral

    const freshNewWalletCount = earlyBuyers.filter(b => b.isFreshNewWallet).length;
    const freshNewWalletRatio = freshNewWalletCount / earlyBuyers.length;
    const cexFundedCount = earlyBuyers.filter(b => b.sourceOfFunds?.hasCEXFunding).length;
    const avgAge = earlyBuyers.reduce((sum, b) => sum + (b.walletAgeDays || 0), 0) / earlyBuyers.length;
    const avgTxCount = earlyBuyers.reduce((sum, b) => sum + (b.txCount || 0), 0) / earlyBuyers.length;

    // Quá nhiều ví mới = đáng ngờ
    if (freshNewWalletRatio > 0.7) score -= 25;
    else if (freshNewWalletRatio > 0.5) score -= 15;
    else if (freshNewWalletRatio < 0.3) score += 10;

    // CEX funded buyers = organic signal
    if (cexFundedCount >= 2) score += 15;
    else if (cexFundedCount >= 1) score += 5;

    // Older wallets on average = more organic
    if (avgAge >= 30) score += 15;
    else if (avgAge >= 7) score += 5;
    else if (avgAge < 1) score -= 10;

    // Higher average tx count = established wallets
    if (avgTxCount >= 50) score += 10;
    else if (avgTxCount >= 10) score += 5;

    return Math.max(0, Math.min(score, 100));
  }

  async _scoreUriMetadataCached(uri) {
    if (this._uriCache.has(uri)) return this._uriCache.get(uri);
    const score = await this._scoreUriMetadata(uri);
    if (this._uriCache.size >= this._uriCacheMaxSize) {
      // Drop oldest entry (FIFO approximation via first inserted key)
      const firstKey = this._uriCache.keys().next().value;
      if (firstKey) this._uriCache.delete(firstKey);
    }
    this._uriCache.set(uri, score);
    return score;
  }

  /**
   * Fetch and score token URI metadata (IPFS/Arweave)
   */
  async _scoreUriMetadata(uri) {
    try {
      // Convert IPFS URI to HTTP gateway
      let fetchUrl = uri;
      if (uri.startsWith('ipfs://')) {
        fetchUrl = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
      }

      const response = await axios.get(fetchUrl, { timeout: 5000 });
      const meta = response.data;

      let score = 0;

      // Has image
      if (meta.image) score += 10;

      // Has description
      if (meta.description && meta.description.length > 10) score += 10;

      // Has social links
      if (meta.twitter || meta.website || meta.telegram) score += 15;

      // Has multiple social links
      const socialCount = [meta.twitter, meta.website, meta.telegram].filter(Boolean).length;
      if (socialCount >= 2) score += 5;

      return Math.min(score, 40);
    } catch (err) {
      logger.debug(`Failed to fetch token URI metadata: ${err.message}`);
      return 0;
    }
  }
}

module.exports = new TokenScorer();
