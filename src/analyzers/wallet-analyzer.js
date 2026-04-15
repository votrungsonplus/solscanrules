const { PublicKey } = require('@solana/web3.js');
const { SolanaConnection: solana, RPC_CATEGORY } = require('../core/solana-connection');
const logger = require('../utils/logger');
const { lamportsToSol, retry, shortenAddress } = require('../utils/helpers');

const settings = require('../config/settings');

// ==================== CONSTANTS ====================
const KNOWN_CEX = {
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'Binance',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'Bybit',
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS': 'Coinbase',
  'ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ': 'OKX',
};

const KNOWN_CEX_KEYS = Object.keys(KNOWN_CEX);

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RAYDIUM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

class WalletAnalyzer {
  constructor() {
    // Cache full analysis results (30 phút)
    this.cache = new Map();
    this.cacheExpiry = 30 * 60 * 1000;

    // Memory Leak Garbage Collector (Vá lỗ hổng sập RAM)
    setInterval(() => {
      const now = Date.now();
      let deleted = 0;
      for (const [key, value] of this.cache.entries()) {
        if (now - value.timestamp > this.cacheExpiry * 2) {
          this.cache.delete(key);
          deleted++;
        }
      }
      if (deleted > 0) logger.debug(`🗑️ GC: Đã dọn dẹp ${deleted} cache ví cũ.`);
    }, 60 * 60 * 1000).unref();
  }

  /**
   * Phân tích đầy đủ một wallet (early buyer)
   * preloadedBalance: Để chống race-condition trong đa luồng
   */
  async analyzeWallet(walletAddress, preloadedBalance = null) {
    const cached = this.cache.get(walletAddress);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      return cached.data;
    }

    const pubkey = new PublicKey(walletAddress);
    logger.debug(`Analyzing wallet: ${shortenAddress(walletAddress)}`);

    // 1. Lấy balance + signatures (luôn song song, tiết kiệm RPC)
    const [balance, signatures] = await Promise.all([
      preloadedBalance !== null ? preloadedBalance : this._getBalance(pubkey),
      this._getSignatures(pubkey, 20),
    ]);

    const txCount = signatures.length;
    const oldestTx = signatures.length > 0 ? signatures[signatures.length - 1] : null;
    const walletAgeSeconds = oldestTx ? Date.now() / 1000 - oldestTx.blockTime : null;
    const walletAgeDays = walletAgeSeconds !== null ? Math.floor(walletAgeSeconds / 86400) : 0;

    // === ĐỊNH NGHĨA DUY NHẤT "VÍ MỚI" — dùng thống nhất toàn hệ thống ===
    // Ví mới = tuổi < 10 tiếng VÀ < 5 giao dịch
    const isFreshNewWallet = (walletAgeSeconds !== null && walletAgeSeconds < 10 * 3600) && txCount < 5;

    let recentTxs = [];
    let fundingTxs = [];
    let sourceOfFunds = { incomingFrom: [], sources: [], hasCEXFunding: false, fundingSourceCount: 0 };
    let recentTokensBought = [];

    if (isFreshNewWallet) {
      // Chỉ fetch tx data cho ví mới toanh (< 10h, < 5 tx) — tiết kiệm RPC tối đa
      if (txCount <= 5) {
        recentTxs = await this._getTransactionsFromSigs(signatures);
        fundingTxs = recentTxs;
      } else {
        const recentSigs = signatures.slice(0, 5);
        const oldestSigs = signatures.slice(-5);
        [recentTxs, fundingTxs] = await Promise.all([
          this._getTransactionsFromSigs(recentSigs),
          this._getTransactionsFromSigs(oldestSigs)
        ]);
      }
      sourceOfFunds = this._analyzeSourceOfFunds(pubkey, fundingTxs);
      recentTokensBought = this._extractTokenBuys(recentTxs, walletAddress);
    }
    // Ví cũ (>= 10h hoặc >= 5 tx): không tốn RPC, bỏ qua hoàn toàn

    // 4. Phân tích funding wallets (chỉ top 1 để tối tốc)
    const fundingWalletDetails = [];
    const funders = (sourceOfFunds.incomingFrom || []).slice(0, 1);

    if (funders.length > 0) {
      const funderAnalyses = await Promise.all(
        funders.map(async (funder) => {
          if (KNOWN_CEX_KEYS.includes(funder)) {
            return { address: funder, txCount: 1000, ageDays: 1000, isFreshNewWallet: false, label: 'CEX' };
          }
          try {
            const funderPubkey = new PublicKey(funder);
            const funderSigs = await this._getSignatures(funderPubkey, 5);
            const funderTxCount = funderSigs.length;
            const funderOldest = funderSigs.length > 0 ? funderSigs[funderSigs.length - 1] : null;
            const funderAgeSeconds = funderOldest ? Date.now() / 1000 - funderOldest.blockTime : null;
            // Dùng cùng tiêu chí isFreshNewWallet: tuổi < 10h VÀ tx < 5
            const funderIsFresh = funderAgeSeconds !== null && funderAgeSeconds < 10 * 3600 && funderTxCount < 5;

            return {
              address: funder,
              txCount: funderTxCount,
              ageDays: funderAgeSeconds !== null ? Math.floor(funderAgeSeconds / 86400) : -1,
              isFreshNewWallet: funderIsFresh,
              label: funderIsFresh ? 'Ví mới' : 'Ví cũ',
            };
          } catch (err) {
            logger.warn(`Funder analysis failed: ${err.message}`);
            return { address: funder, txCount: -1, ageDays: -1, isFreshNewWallet: false, label: 'Ví cũ' };
          }
        })
      );
      fundingWalletDetails.push(...funderAnalyses);
    }

    const result = {
      address: walletAddress,
      balance: lamportsToSol(balance),
      walletAgeDays,
      walletAgeSeconds,
      txCount,
      sourceOfFunds,
      isFreshNewWallet,
      label: isFreshNewWallet ? 'Ví mới' : 'Ví cũ',
      fundingWallets: sourceOfFunds.incomingFrom || [],
      fundingWalletDetails,
      recentTokensBought,
      firstTxTimestamp: oldestTx ? oldestTx.blockTime : null,
    };

    this.cache.set(walletAddress, { data: result, timestamp: Date.now() });
    return result;
  }

  /**
   * Phân tích nhiều wallet cùng lúc với concurrency cao + batch balance an toàn
   */
  async analyzeEarlyBuyers(walletAddresses) {
    if (!walletAddresses || walletAddresses.length === 0) return [];
    const batchSize = settings.performance.tier === 'WARP' ? 10 : 5;
    
    // ── BATCH BALANCE (1 RPC) LOCAL SCOPE CHỐNG RACE CONDITION ──
    const localBalances = new Map();
    try {
      const pubkeys = walletAddresses.map((a) => new PublicKey(a));
      const accountsBatch = await solana.execute(
        (conn) => conn.getMultipleAccountsInfo(pubkeys),
        RPC_CATEGORY.ANALYSIS
      );
      walletAddresses.forEach((addr, i) => {
        const acc = accountsBatch?.[i];
        localBalances.set(addr, acc ? acc.lamports : 0);
      });
    } catch (err) {
      logger.warn(`Batch balance fetch failed: ${err.message}`);
    }

    // ── Xử lý theo batch song song ──
    const results = [];
    for (let i = 0; i < walletAddresses.length; i += batchSize) {
      const batch = walletAddresses.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map((addr) => this.analyzeWallet(addr, localBalances.get(addr) || null))
      );

      for (const res of batchResults) {
        if (res.status === 'fulfilled') {
          results.push(res.value);
        }
      }
    }
    return results;
  }

  detectClusterFromCache(walletAddresses) {
    const analyses = [];
    for (const addr of walletAddresses) {
      const cached = this.cache.get(addr);
      if (cached) analyses.push(cached.data);
    }
    if (analyses.length === 0) {
      return { walletCount: 0, sharedFunders: [], isLikelyCluster: false, riskLevel: 'LOW', wallets: [] };
    }
    return this._detectClusterFromAnalyses(analyses);
  }

  async detectCluster(walletAddresses) {
    const analyses = await this.analyzeEarlyBuyers(walletAddresses);
    return this._detectClusterFromAnalyses(analyses);
  }

  _detectClusterFromAnalyses(analyses) {
    const fundingSources = {};
    const funderDetails = {};

    for (const wallet of analyses) {
      for (const funder of wallet.fundingWallets || []) {
        fundingSources[funder] = (fundingSources[funder] || 0) + 1;
      }
      for (const fd of wallet.fundingWalletDetails || []) {
        funderDetails[fd.address] = fd;
      }
    }

    const sharedFunders = Object.entries(fundingSources)
      .filter(([_, count]) => count >= 2)
      .map(([address, count]) => {
        const detail = funderDetails[address] || {};
        return {
          address,
          sharedBy: count,
          isFreshNewWallet: detail.isFreshNewWallet || false,
          label: detail.label || 'Ví cũ',
          txCount: detail.txCount ?? -1,
          ageDays: detail.ageDays ?? -1,
        };
      });

    const ages = analyses.map((a) => a.walletAgeDays);
    const avgAge = ages.length ? ages.reduce((s, a) => s + a, 0) / ages.length : 0;
    const similarAge = ages.every((a) => Math.abs(a - avgAge) < 7);

    const balances = analyses.map((a) => a.balance);
    const avgBalance = balances.length ? balances.reduce((s, b) => s + b, 0) / balances.length : 0;
    const similarBalance = balances.every((b) => {
      const diff = Math.abs(b - avgBalance) / Math.max(avgBalance, 0.001);
      return diff < 0.3;
    });

    const freshNewWalletCount = analyses.filter((a) => a.isFreshNewWallet).length;

    return {
      walletCount: analyses.length,
      sharedFunders,
      similarAge,
      similarBalance,
      freshNewWalletCount,
      freshNewWalletRatio: analyses.length ? freshNewWalletCount / analyses.length : 0,
      isLikelyCluster: sharedFunders.length > 0 || (similarAge && similarBalance && freshNewWalletCount > 1),
      riskLevel: this._calculateClusterRisk(sharedFunders, similarAge, similarBalance, freshNewWalletCount, analyses.length),
      wallets: analyses,
    };
  }

  async _getBalance(pubkey) {
    return retry(() => solana.execute((conn) => conn.getBalance(pubkey), RPC_CATEGORY.ANALYSIS));
  }

  async _getSignatures(pubkey, limit) {
    return retry(() => solana.execute((conn) => conn.getSignaturesForAddress(pubkey, { limit }), RPC_CATEGORY.ANALYSIS));
  }

  async _getTransactionsFromSigs(signaturesArray) {
    if (!signaturesArray || signaturesArray.length === 0) return [];
    const txs = [];
    const BATCH = 3;
    for (let i = 0; i < signaturesArray.length; i += BATCH) {
      const batch = signaturesArray.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map((sig) =>
          retry(() =>
            solana.execute((conn) =>
              conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 }),
              RPC_CATEGORY.ANALYSIS
            )
          )
        )
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) txs.push(r.value);
      }
    }
    return txs;
  }

  _analyzeSourceOfFunds(pubkey, transactions) {
    const address = pubkey.toBase58();
    const incomingFrom = new Set();
    const sources = [];

    for (const tx of transactions) {
      if (!tx?.meta?.preBalances || !tx?.meta?.postBalances || !tx?.transaction?.message) continue;

      const accounts = tx.transaction.message.accountKeys.map((k) =>
        typeof k === 'string' ? k : k.pubkey?.toBase58?.() || k.pubkey || ''
      );
      const preBalances = tx.meta.preBalances;
      const postBalances = tx.meta.postBalances;

      for (let i = 0; i < accounts.length; i++) {
        const diff = (postBalances[i] || 0) - (preBalances[i] || 0);
        const acct = accounts[i];
        if (acct === address && diff > 0) {
          for (let j = 0; j < accounts.length; j++) {
            if (j === i) continue;
            const senderDiff = (postBalances[j] || 0) - (preBalances[j] || 0);
            if (senderDiff < 0) {
              const sender = accounts[j];
              incomingFrom.add(sender);
              if (KNOWN_CEX[sender]) {
                sources.push({ type: 'cex', name: KNOWN_CEX[sender], address: sender });
              } else {
                sources.push({ type: 'wallet', address: sender, amount: lamportsToSol(Math.abs(senderDiff)) });
              }
            }
          }
        }
      }
    }

    return {
      incomingFrom: [...incomingFrom],
      sources,
      hasCEXFunding: sources.some((s) => s.type === 'cex'),
      fundingSourceCount: incomingFrom.size,
    };
  }

  _extractTokenBuys(transactions, walletAddress) {
    const buys = [];
    for (const tx of transactions) {
      if (!tx?.meta || !tx?.transaction?.message) continue;

      const logs = tx.meta.logMessages || [];
      const isPump = logs.some((log) => log.includes(PUMP_PROGRAM));
      const isRaydium = logs.some((log) => log.includes(RAYDIUM_PROGRAM));

      if (!isPump && !isRaydium) continue;

      const preTokenBalances = tx.meta.preTokenBalances || [];
      const postTokenBalances = tx.meta.postTokenBalances || [];
      let tokenMint = null;
      let amount = 0;

      for (const post of postTokenBalances) {
        if (post.owner !== walletAddress) continue;
        const pre = preTokenBalances.find((p) => p.accountIndex === post.accountIndex) || { uiTokenAmount: { uiAmount: 0 } };
        const delta = (post.uiTokenAmount.uiAmount || 0) - (pre.uiTokenAmount.uiAmount || 0);

        if (delta > 0.0001) {
          tokenMint = post.mint;
          amount = delta;
          break;
        }
      }

      buys.push({
        signature: tx.transaction.signatures?.[0] || '',
        blockTime: tx.blockTime,
        program: isPump ? 'pump' : 'raydium',
        tokenMint,
        amount: Number(amount.toFixed(6)),
      });
    }
    return buys;
  }

  _calculateClusterRisk(sharedFunders, similarAge, similarBalance, freshNewWalletCount, totalWallets) {
    let score = 0;
    if (sharedFunders.length > 0) score += 30;
    if (sharedFunders.length > 2) score += 20;
    if (similarAge) score += 15;
    if (similarBalance) score += 15;
    if (totalWallets > 0 && freshNewWalletCount / totalWallets > 0.5) score += 20;

    if (score >= 60) return 'HIGH';
    if (score >= 30) return 'MEDIUM';
    return 'LOW';
  }

  clearCache() {
    this.cache.clear();
  }
}

module.exports = new WalletAnalyzer();
