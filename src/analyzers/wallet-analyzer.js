const { PublicKey } = require('@solana/web3.js');
const { SolanaConnection: solana, RPC_CATEGORY } = require('../core/solana-connection');
const logger = require('../utils/logger');
const { lamportsToSol, retry, shortenAddress } = require('../utils/helpers');

const settings = require('../config/settings');
const { HOTWALLETS: KNOWN_CEX, KNOWN_CEX_KEYS, isKnownCex, getCexLabel } = require('../config/cex-hotwallets');
const { FRESH_WALLET, FUNDING_TRACE } = require('../config/wallet-classifier.constants');

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RAYDIUM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

class WalletAnalyzer {
  constructor() {
    // Cache full analysis results (30 phút)
    this.cache = new Map();
    this.cacheExpiry = 30 * 60 * 1000;
    // Cache peel-chain trace riêng để tránh trace lại funder dùng chung nhiều ví
    this.peelChainCache = new Map();

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
      for (const [key, value] of this.peelChainCache.entries()) {
        if (now - value.timestamp > FUNDING_TRACE.cacheTtlMs * 2) {
          this.peelChainCache.delete(key);
        }
      }
      if (deleted > 0) logger.debug(`🗑️ GC: Đã dọn dẹp ${deleted} cache ví cũ.`);
    }, 60 * 60 * 1000).unref();
  }

  /**
   * Phân tích đầy đủ một wallet (early buyer)
   * preloadedBalance: Để chống race-condition trong đa luồng
   * deployerAddress: Optional — để peel-chain dừng khi gặp deployer (insider signal)
   */
  async analyzeWallet(walletAddress, preloadedBalance = null, deployerAddress = null) {
    const cached = this.cache.get(walletAddress);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      return cached.data;
    }

    const pubkey = new PublicKey(walletAddress);
    logger.debug(`Analyzing wallet: ${shortenAddress(walletAddress)}`);

    // 1. Lấy balance + signatures (sigLookupLimit cao để tính đúng tuổi cho ví bot)
    const [balance, signatures] = await Promise.all([
      preloadedBalance !== null ? preloadedBalance : this._getBalance(pubkey),
      this._getSignatures(pubkey, FRESH_WALLET.sigLookupLimit),
    ]);

    const txCount = signatures.length;
    const oldestTx = signatures.length > 0 ? signatures[signatures.length - 1] : null;
    // Nếu txCount === sigLookupLimit thì oldestTx có thể KHÔNG phải tx đầu tiên thật.
    // Trong trường hợp đó, ví chắc chắn không fresh — đánh dấu ageSeconds = Infinity
    // để loại khỏi nhánh isFreshNewWallet.
    const sigLimitMaxedOut = txCount >= FRESH_WALLET.sigLookupLimit;
    const walletAgeSeconds = oldestTx
      ? (sigLimitMaxedOut ? Infinity : Date.now() / 1000 - oldestTx.blockTime)
      : null;
    const walletAgeDays = walletAgeSeconds !== null && Number.isFinite(walletAgeSeconds)
      ? Math.floor(walletAgeSeconds / 86400)
      : (sigLimitMaxedOut ? 999 : 0);

    // === Định nghĩa "ví mới" — siết chặt: tuổi < maxAgeSeconds VÀ tx <= maxTxCount ===
    const isFreshNewWallet =
      walletAgeSeconds !== null &&
      Number.isFinite(walletAgeSeconds) &&
      walletAgeSeconds < FRESH_WALLET.maxAgeSeconds &&
      txCount <= FRESH_WALLET.maxTxCount;

    let recentTxs = [];
    let fundingTxs = [];
    let sourceOfFunds = { incomingFrom: [], sources: [], hasCEXFunding: false, fundingSourceCount: 0 };
    let recentTokensBought = [];
    let peelChain = null;

    if (isFreshNewWallet) {
      // Ví mới: fetch toàn bộ tx (≤ maxTxCount) để analyze funding chính xác
      recentTxs = await this._getTransactionsFromSigs(signatures.slice(0, FRESH_WALLET.maxTxCount + 3));
      fundingTxs = recentTxs;
      sourceOfFunds = this._analyzeSourceOfFunds(pubkey, fundingTxs);
      recentTokensBought = this._extractTokenBuys(recentTxs, walletAddress);

      // Peel-chain trace từ ví fresh — tracking xem chain dẫn về đâu
      // (CEX = organic, deployer = insider, unknown = đáng ngờ)
      try {
        peelChain = await this._peelChainTrace(walletAddress, deployerAddress);
      } catch (err) {
        logger.debug(`Peel-chain trace failed for ${shortenAddress(walletAddress)}: ${err.message}`);
      }
    }

    // 4. Phân tích funding wallets — trace ALL incoming funders (max maxFundersPerWallet)
    const fundingWalletDetails = [];
    const funders = (sourceOfFunds.incomingFrom || []).slice(0, FUNDING_TRACE.maxFundersPerWallet);

    if (funders.length > 0) {
      const funderAnalyses = await Promise.all(
        funders.map(async (funder) => {
          if (isKnownCex(funder)) {
            return {
              address: funder,
              txCount: 1000,
              ageDays: 1000,
              isFreshNewWallet: false,
              label: getCexLabel(funder) || 'CEX',
              isCex: true,
            };
          }
          try {
            const funderPubkey = new PublicKey(funder);
            const funderSigs = await this._getSignatures(funderPubkey, 20);
            const funderTxCount = funderSigs.length;
            const funderOldest = funderSigs.length > 0 ? funderSigs[funderSigs.length - 1] : null;
            const funderSigLimitMaxed = funderTxCount >= 20;
            const funderAgeSeconds = funderOldest
              ? (funderSigLimitMaxed ? Infinity : Date.now() / 1000 - funderOldest.blockTime)
              : null;
            const funderIsFresh =
              funderAgeSeconds !== null &&
              Number.isFinite(funderAgeSeconds) &&
              funderAgeSeconds < FRESH_WALLET.maxAgeSeconds &&
              funderTxCount <= FRESH_WALLET.maxTxCount;

            return {
              address: funder,
              txCount: funderTxCount,
              ageDays: funderAgeSeconds !== null && Number.isFinite(funderAgeSeconds)
                ? Math.floor(funderAgeSeconds / 86400)
                : (funderSigLimitMaxed ? 999 : -1),
              isFreshNewWallet: funderIsFresh,
              label: funderIsFresh ? 'Ví mới' : 'Ví cũ',
              isCex: false,
            };
          } catch (err) {
            logger.warn(`Funder analysis failed: ${err.message}`);
            return { address: funder, txCount: -1, ageDays: -1, isFreshNewWallet: false, label: 'Ví cũ', isCex: false };
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
      sigLimitMaxedOut,
      sourceOfFunds,
      isFreshNewWallet,
      label: isFreshNewWallet ? 'Ví mới' : 'Ví cũ',
      fundingWallets: sourceOfFunds.incomingFrom || [],
      fundingWalletDetails,
      peelChain,
      recentTokensBought,
      firstTxTimestamp: oldestTx ? oldestTx.blockTime : null,
    };

    this.cache.set(walletAddress, { data: result, timestamp: Date.now() });
    return result;
  }

  /**
   * Peel-chain trace: từ một ví fresh, theo dõi nguồn fund N hop về sau.
   *   - Dừng khi: gặp CEX, gặp deployer, đến maxHops, hoặc không còn funder.
   *   - Mỗi hop chỉ lấy top 1 incoming funder (giảm RPC).
   *   - Cache theo địa chỉ start để các ví khác cùng nhánh không re-trace.
   * Returns: { terminus, terminusLabel, chain[], hops }
   *   terminus: 'CEX' | 'DEPLOYER' | 'UNKNOWN' | 'DEPTH_LIMIT' | 'NO_FUNDER'
   */
  async _peelChainTrace(startAddress, deployerAddress = null) {
    const cached = this.peelChainCache.get(startAddress);
    if (cached && Date.now() - cached.timestamp < FUNDING_TRACE.cacheTtlMs) {
      return cached.data;
    }

    const visited = new Set([startAddress]);
    const chain = [];
    let current = startAddress;
    let terminus = 'DEPTH_LIMIT';
    let terminusLabel = null;

    for (let hop = 0; hop < FUNDING_TRACE.maxHops; hop++) {
      // Check terminus điều kiện ở current trước khi trace tiếp
      if (deployerAddress && current === deployerAddress) {
        terminus = 'DEPLOYER';
        terminusLabel = 'deployer';
        break;
      }
      if (isKnownCex(current)) {
        terminus = 'CEX';
        terminusLabel = getCexLabel(current);
        break;
      }

      // Lấy top 1 incoming funder của current
      let nextFunder = null;
      try {
        const pubkey = new PublicKey(current);
        const sigs = await this._getSignatures(pubkey, 10);
        if (sigs.length === 0) {
          terminus = 'NO_FUNDER';
          break;
        }
        const oldestSigs = sigs.slice(-3);
        const oldestTxs = await this._getTransactionsFromSigs(oldestSigs);
        const sof = this._analyzeSourceOfFunds(pubkey, oldestTxs);
        nextFunder = (sof.incomingFrom || []).find(f => !visited.has(f)) || null;
      } catch (err) {
        terminus = 'NO_FUNDER';
        break;
      }

      if (!nextFunder) {
        terminus = 'NO_FUNDER';
        break;
      }

      chain.push({ from: current, fundedBy: nextFunder, hop: hop + 1 });
      visited.add(nextFunder);
      current = nextFunder;
    }

    // Re-check terminus tại current sau khi loop kết thúc
    if (terminus === 'DEPTH_LIMIT') {
      if (deployerAddress && current === deployerAddress) {
        terminus = 'DEPLOYER';
        terminusLabel = 'deployer';
      } else if (isKnownCex(current)) {
        terminus = 'CEX';
        terminusLabel = getCexLabel(current);
      } else {
        terminus = 'UNKNOWN';
      }
    }

    const result = {
      start: startAddress,
      terminus,
      terminusLabel,
      terminusAddress: current,
      chain,
      hops: chain.length,
    };
    this.peelChainCache.set(startAddress, { data: result, timestamp: Date.now() });
    return result;
  }

  /**
   * Phân tích nhiều wallet cùng lúc với concurrency cao + batch balance an toàn
   * deployerAddress: optional — forward xuống analyzeWallet để peel-chain dừng ở deployer
   */
  async analyzeEarlyBuyers(walletAddresses, deployerAddress = null) {
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
        batch.map((addr) => this.analyzeWallet(addr, localBalances.get(addr) || null, deployerAddress))
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
          isCex: detail.isCex || false,
          txCount: detail.txCount ?? -1,
          ageDays: detail.ageDays ?? -1,
        };
      });

    // Peel-chain analysis: gộp các ví theo terminus của chain (CEX label / deployer / unknown).
    // Multi-hop sharing: nếu nhiều ví fresh peel về cùng terminusAddress (và terminusAddress
    // KHÔNG phải CEX) → đây là tín hiệu cluster MẠNH (insider rửa qua nhiều ví trung gian).
    const peelTerminusMap = new Map(); // terminusAddress -> count
    let insiderPeelCount = 0; // số ví peel-chain dẫn về deployer
    for (const w of analyses) {
      const pc = w.peelChain;
      if (!pc) continue;
      if (pc.terminus === 'DEPLOYER') {
        insiderPeelCount++;
      }
      if (pc.terminusAddress && pc.terminus !== 'CEX') {
        peelTerminusMap.set(pc.terminusAddress, (peelTerminusMap.get(pc.terminusAddress) || 0) + 1);
      }
    }
    const sharedPeelTermini = [...peelTerminusMap.entries()]
      .filter(([_, c]) => c >= 2)
      .map(([address, count]) => ({ address, sharedBy: count }));

    // Loại bỏ shared funder là CEX khỏi cluster signal — CEX trùng KHÔNG phải insider
    const realSharedFunders = sharedFunders.filter(f => !f.isCex);

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
      sharedFunders: realSharedFunders,
      sharedFundersIncludingCex: sharedFunders, // expose để debug
      sharedPeelTermini,
      insiderPeelCount,
      similarAge,
      similarBalance,
      freshNewWalletCount,
      freshNewWalletRatio: analyses.length ? freshNewWalletCount / analyses.length : 0,
      // Cluster thật khi: shared funder non-CEX, hoặc peel-chain shared terminus, hoặc insider peel
      isLikelyCluster:
        realSharedFunders.length > 0 ||
        sharedPeelTermini.length > 0 ||
        insiderPeelCount > 0 ||
        (similarAge && similarBalance && freshNewWalletCount > 1),
      riskLevel: this._calculateClusterRisk(realSharedFunders, similarAge, similarBalance, freshNewWalletCount, analyses.length, insiderPeelCount, sharedPeelTermini.length),
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
              const cexLabel = getCexLabel(sender);
              if (cexLabel) {
                sources.push({ type: 'cex', name: cexLabel, address: sender });
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

  _calculateClusterRisk(sharedFunders, similarAge, similarBalance, freshNewWalletCount, totalWallets, insiderPeelCount = 0, sharedPeelTerminiCount = 0) {
    let score = 0;
    if (sharedFunders.length > 0) score += 30;
    if (sharedFunders.length > 2) score += 20;
    if (similarAge) score += 15;
    if (similarBalance) score += 15;
    if (totalWallets > 0 && freshNewWalletCount / totalWallets > 0.5) score += 20;
    // Peel-chain signals — insider rất mạnh (rửa qua nhiều hop về deployer)
    if (insiderPeelCount > 0) score += 40;
    if (sharedPeelTerminiCount > 0) score += 25;

    if (score >= 60) return 'HIGH';
    if (score >= 30) return 'MEDIUM';
    return 'LOW';
  }

  clearCache() {
    this.cache.clear();
  }
}

module.exports = new WalletAnalyzer();
