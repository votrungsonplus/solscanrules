const { PublicKey } = require('@solana/web3.js');
const { SolanaConnection: solana, RPC_CATEGORY } = require('../core/solana-connection');
const logger = require('../utils/logger');
const { retry, shortenAddress } = require('../utils/helpers');

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

class DevAnalyzer {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = 10 * 60 * 1000; // 10 minutes
  }

  /**
   * Analyze the deployer wallet of a new token
   * Returns risk score and detailed history
   */
  async analyzeDeployer(deployerAddress) {
    const cached = this.cache.get(deployerAddress);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      return cached.data;
    }

    logger.debug(`Analyzing deployer: ${shortenAddress(deployerAddress)}`);

    if (!deployerAddress || deployerAddress.length < 32 || deployerAddress === 'UNKNOWN') {
      return {
        address: deployerAddress || 'UNKNOWN',
        balanceSol: 0,
        totalTxCount: 0,
        tokensDeployed: 0,
        averageTokenLifespan: 0,
        rugPullCount: 0,
        rugPullRatio: 0,
        recentTokens: [],
        riskScore: 60,
        riskLevel: 'MEDIUM',
        walletAge: 0,
      };
    }

    const pubkey = new PublicKey(deployerAddress);

    // Parallel RPC calls
    const [balance, signatures] = await Promise.all([
      retry(() => solana.execute(conn => conn.getBalance(pubkey), RPC_CATEGORY.ANALYSIS)),
      retry(() => solana.execute(conn => conn.getSignaturesForAddress(pubkey, { limit: 50 }), RPC_CATEGORY.ANALYSIS)),
    ]);

    // Parse a sample of recent transactions to identify PumpFun creates and sells
    const tokenHistory = await this._analyzeTokenHistory(signatures);

    const result = {
      address: deployerAddress,
      balanceSol: balance / 1e9,
      totalTxCount: signatures.length,
      tokensDeployed: tokenHistory.length,
      averageTokenLifespan: this._calcAvgLifespan(tokenHistory),
      rugPullCount: tokenHistory.filter(t => t.suspectedRug).length,
      rugPullRatio: tokenHistory.length > 0
        ? tokenHistory.filter(t => t.suspectedRug).length / tokenHistory.length
        : 0,
      recentTokens: tokenHistory.slice(0, 10),
      riskScore: 0, // calculated below
      riskLevel: 'UNKNOWN',
      walletAge: signatures.length > 0
        ? Math.floor((Date.now() / 1000 - signatures[signatures.length - 1].blockTime) / 86400)
        : 0,
    };

    // Calculate risk score (0-100, higher = more risky)
    result.riskScore = this._calculateRiskScore(result);
    result.riskLevel = result.riskScore >= 70 ? 'HIGH' : result.riskScore >= 40 ? 'MEDIUM' : 'LOW';

    this.cache.set(deployerAddress, { data: result, timestamp: Date.now() });
    return result;
  }

  /**
   * Analyze token history by parsing actual transactions to detect PumpFun creates and quick sells
   * Fetches parsed transactions in batch to identify real deploy + sell patterns
   */
  async _analyzeTokenHistory(signatures) {
    if (signatures.length === 0) return [];

    // Fetch parsed transactions for up to 15 recent signatures (batched RPC)
    const sigsToFetch = signatures.slice(0, 15).map(s => s.signature);
    let parsedTxs = [];
    try {
      parsedTxs = await retry(() => solana.execute(conn =>
        conn.getParsedTransactions(sigsToFetch, { maxSupportedTransactionVersion: 0 }),
        RPC_CATEGORY.ANALYSIS
      ));
    } catch (err) {
      logger.debug(`Failed to fetch parsed txs for deployer: ${err.message}`);
      // Fallback to heuristic if parsed fetch fails
      return this._estimateTokenCreationHistoryFallback(signatures);
    }

    // Identify PumpFun create and sell transactions
    const creates = []; // { signature, blockTime, mint }
    const sells = [];   // { signature, blockTime, mint }

    for (let i = 0; i < parsedTxs.length; i++) {
      const tx = parsedTxs[i];
      if (!tx || tx.meta?.err) continue;

      const blockTime = tx.blockTime || signatures[i].blockTime;
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      const programIds = accountKeys
        .filter(k => k.signer === false)
        .map(k => (typeof k.pubkey === 'string' ? k.pubkey : k.pubkey?.toBase58?.()) || '');

      const hasPumpFun = programIds.includes(PUMP_PROGRAM_ID) ||
        accountKeys.some(k => {
          const addr = typeof k.pubkey === 'string' ? k.pubkey : k.pubkey?.toBase58?.();
          return addr === PUMP_PROGRAM_ID;
        });

      if (!hasPumpFun) continue;

      // Check log messages to distinguish create vs sell
      const logs = tx.meta?.logMessages || [];
      const logText = logs.join(' ');

      // PumpFun create instruction typically has "Program log: Instruction: Create" or "InitializeMint"
      const isCreate = logText.includes('Instruction: Create') ||
        logText.includes('InitializeMint') ||
        logText.includes('create');

      // PumpFun sell typically shows "Instruction: Sell" in logs
      const isSell = logText.includes('Instruction: Sell');

      if (isCreate) {
        creates.push({
          signature: signatures[i].signature,
          blockTime,
          suspectedRug: false,
        });
      } else if (isSell) {
        sells.push({
          signature: signatures[i].signature,
          blockTime,
        });
      }
    }

    // Detect quick dumps: if deployer sold within 10 minutes of creating a token
    const QUICK_DUMP_WINDOW = 10 * 60; // 10 minutes in seconds
    for (const create of creates) {
      const quickSell = sells.find(s =>
        s.blockTime > create.blockTime &&
        s.blockTime - create.blockTime < QUICK_DUMP_WINDOW
      );
      if (quickSell) {
        create.suspectedRug = true;
      }
    }

    // If no PumpFun creates detected via parsing, fall back to heuristic
    if (creates.length === 0) {
      return this._estimateTokenCreationHistoryFallback(signatures);
    }

    return creates;
  }

  /**
   * Fallback: Estimate token creation history from signature timing patterns
   * Used when parsed transaction fetch fails
   */
  _estimateTokenCreationHistoryFallback(signatures) {
    const tokens = [];
    let lastTime = 0;

    for (const sig of signatures) {
      if (!sig.blockTime) continue;
      if (sig.blockTime - lastTime > 30 || lastTime === 0) {
        tokens.push({
          signature: sig.signature,
          blockTime: sig.blockTime,
          suspectedRug: false,
        });
      }
      lastTime = sig.blockTime;
    }

    return tokens;
  }

  _calcAvgLifespan(tokenHistory) {
    if (tokenHistory.length < 2) return 0;
    const spans = [];
    for (let i = 0; i < tokenHistory.length - 1; i++) {
      spans.push(tokenHistory[i].blockTime - tokenHistory[i + 1].blockTime);
    }
    return spans.reduce((s, v) => s + v, 0) / spans.length;
  }

  /**
   * Risk scoring based on deployer behavior
   */
  _calculateRiskScore(analysis) {
    let score = 0;

    // Many tokens deployed = higher risk (serial deployer)
    if (analysis.tokensDeployed > 10) score += 30;
    else if (analysis.tokensDeployed > 5) score += 20;
    else if (analysis.tokensDeployed > 2) score += 10;

    // High rug pull ratio (now actually functional with parsed tx detection)
    if (analysis.rugPullRatio > 0.5) score += 30;
    else if (analysis.rugPullRatio > 0.3) score += 20;
    else if (analysis.rugPullRatio > 0) score += 10;

    // Any rug pulls detected at all is a warning
    if (analysis.rugPullCount > 0) score += 5;

    // New wallet (less than 7 days)
    if (analysis.walletAge < 7) score += 15;

    // Very new wallet (< 1 day) — likely created just for this deploy
    if (analysis.walletAge < 1) score += 10;

    // Low balance (might have just been funded for this deploy)
    if (analysis.balanceSol < 0.5) score += 10;

    // Very high tx count in short time (bot-like serial deployer)
    if (analysis.totalTxCount > 50 && analysis.walletAge < 30) score += 15;

    // Very short average time between deploys (< 1 hour = factory deployer)
    if (analysis.averageTokenLifespan > 0 && analysis.averageTokenLifespan < 3600) score += 10;

    return Math.min(score, 100);
  }

  clearCache() {
    this.cache.clear();
  }
}

module.exports = new DevAnalyzer();
