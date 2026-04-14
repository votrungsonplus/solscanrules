const {
  Transaction,
  SystemProgram,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} = require('@solana/web3.js');
const EventEmitter = require('events');
const axios = require('axios');
const http = require('http');
const https = require('https');
const { SolanaConnection: solana, RPC_CATEGORY } = require('../core/solana-connection');
const settings = require('../config/settings');
const logger = require('../utils/logger');
const { solToLamports, retry, formatSol, sleep } = require('../utils/helpers');

class BuyExecutor extends EventEmitter {
  constructor() {
    super();
    this.pendingBuys = new Map(); // mint -> { mint, solAmount, status, timestamp }
    this.axiosInstance = axios.create({
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
      timeout: 15000,
    });
  }

  getPendingBuys() {
    return Array.from(this.pendingBuys.values());
  }

  _updatePending(mint, data) {
    if (data === null) {
      this.pendingBuys.delete(mint);
    } else {
      const existing = this.pendingBuys.get(mint) || { mint, timestamp: Date.now() };
      this.pendingBuys.set(mint, { ...existing, ...data });
    }
    this.emit('pendingUpdate', this.getPendingBuys());
  }

  /**
   * Execute a buy on PumpFun bonding curve
   * Uses PumpPortal API for transaction building
   */
  /**
   * Execute a buy on PumpFun bonding curve
   * Uses PumpPortal API for transaction building
   */
  async buyToken(mint, solAmount) {
    const wallet = solana.getWallet();
    if (!wallet) throw new Error('No wallet configured');

    // Check balance first
    const balance = await solana.getBalance();
    const needed = solAmount + settings.fees.maxPriorityFee + (settings.jito.enabled ? settings.jito.tipAmount : 0);
    logger.info(`🛒 Buying ${formatSol(solAmount)} of ${mint} | Balance: ${formatSol(balance)} | Needed: ${formatSol(needed)}`);
    if (balance < needed) {
      throw new Error(`Insufficient balance: ${formatSol(balance)} < ${formatSol(needed)}`);
    }

    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const attemptTag = attempt > 1 ? `[Retry ${attempt-1}/${maxAttempts-1}] ` : '';
        this._updatePending(mint, { solAmount, status: `${attemptTag}📍 Đang kiểm tra Jupiter...` });
        
        let signature;
        try {
          // 1. Try Jupiter first (User Priority)
          signature = await this._buyWithJupiter(mint, solAmount, wallet);
        } catch(jupErr) {
          // 2. Fallback to PumpPortal if Jupiter fails (e.g. not indexed yet)
          logger.warn(`${attemptTag}Jupiter route not available for ${mint}: ${jupErr.message}. Falling back to PumpPortal...`);
          this._updatePending(mint, { status: `${attemptTag}📍 Bẻ lái sang PumpPortal...` });
          
          if (settings.jito.enabled) {
            signature = await this._buyWithJito(mint, solAmount, wallet);
          } else {
            signature = await this._buyDirect(mint, solAmount, wallet);
          }
        }

        // Log post-buy balance asynchronously
        solana.getBalance().then(newBal => {
          logger.info(`💰 Post-buy balance: ${formatSol(newBal)} (spent ~${formatSol(balance - newBal)})`);
        }).catch(() => {});

        logger.info(`✅ Buy executed: ${signature}`);

        // Fetch actual token amount received (wait up to 5s if needed for indexer)
        let tokenAmount = 0;
        for (let i = 0; i < 5; i++) {
          tokenAmount = await solana.getTokenBalance(mint);
          if (tokenAmount > 0) break;
          await sleep(1000);
        }

        this._updatePending(mint, null); // Clear pending on success
        return { success: true, signature, mint, solAmount, tokenAmount, timestamp: Date.now(), attempt };
      } catch (err) {
        lastError = err;
        logger.error(`❌ Attempt ${attempt} failed for ${mint}: ${err.message}`);
        
        if (attempt < maxAttempts) {
          const delay = 800; // aggressive retry delay
          this._updatePending(mint, { status: `⚠️ Lỗi: ${err.message.slice(0, 20)}... Thử lại ${attempt}/${maxAttempts-1} sau ${delay}ms` });
          await sleep(delay);
        }
      }
    }

    // If we reach here, all attempts failed
    this._updatePending(mint, null); // Clear pending on final failure
    return { success: false, error: lastError.message, mint, solAmount, timestamp: Date.now() };
  }

  /**
   * Calculate dynamic priority fee based on recent network activity
   */
  async _getDynamicPriorityFee() {
    try {
      const fees = await solana.execute(conn => conn.getRecentPrioritizationFees(), RPC_CATEGORY.TRADING);
      if (!fees || fees.length === 0) return settings.fees.minPriorityFee;

      // Get the 75th percentile fee from recent blocks
      const sortedFees = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
      const p75 = sortedFees[Math.floor(sortedFees.length * 0.75)];
      
      // Convert micro-lamports to SOL and apply multiplier
      const feeInSol = (p75 / 1e6 / 1e9) * settings.fees.priorityFeeMultiplier;
      
      return Math.min(Math.max(feeInSol, settings.fees.minPriorityFee), settings.fees.maxPriorityFee);
    } catch (err) {
      logger.warn(`Failed to fetch priority fees: ${err.message}. Using default.`);
      return settings.fees.minPriorityFee;
    }
  }

  /**
   * Direct buy using PumpPortal API with dynamic priority fee
   */
  async _buyDirect(mint, solAmount, wallet) {
    const priorityFee = await this._getDynamicPriorityFee();
    logger.debug(`Using priority fee: ${priorityFee.toFixed(6)} SOL`);

    // Build transaction via PumpPortal API
    const response = await this.axiosInstance.post('https://pumpportal.fun/api/trade-local', {
      publicKey: wallet.publicKey.toBase58(),
      action: 'buy',
      mint,
      amount: solAmount,
      denominatedInSol: 'true',
      slippage: settings.trading.buySlippage,
      priorityFee: priorityFee,
      pool: 'pump',
    }, { responseType: 'arraybuffer' });

    if (!response.data) throw new Error('No transaction data from PumpPortal');

    const txBuffer = Buffer.from(response.data);
    const tx = VersionedTransaction.deserialize(txBuffer);
    tx.sign([wallet]);

    const rawTxBase64 = Buffer.from(tx.serialize()).toString('base64');
    const signature = await solana.submitViaSender(rawTxBase64);

    // Verify confirmation asynchronously
    solana.getExecutionConnection().confirmTransaction(signature, 'confirmed').catch(e => logger.warn(`Confirmation error: ${e.message}`));
    return signature;
  }

  /**
   * Buy using Jito bundle with proper tip instruction
   */
  async _buyWithJito(mint, solAmount, wallet) {
    // 1. Build the base transaction via PumpPortal
    const response = await this.axiosInstance.post('https://pumpportal.fun/api/trade-local', {
      publicKey: wallet.publicKey.toBase58(),
      action: 'buy',
      mint,
      amount: solAmount,
      denominatedInSol: 'true',
      slippage: settings.trading.buySlippage,
      priorityFee: 0.00001, // Minimal priority fee when using Jito tip
      pool: 'pump',
    }, { responseType: 'arraybuffer' });

    if (!response.data) throw new Error('No transaction data from PumpPortal');

    const txBuffer = Buffer.from(response.data);
    const tx = VersionedTransaction.deserialize(txBuffer);

    // 2. Add Jito Tip instruction
    // Jito Tip Accounts: https://jito-labs.gitbook.io/mev/searcher-resources/bundles/rpc-api-reference/sendbundle
    const jitoTipAccounts = (settings.jito.tipAccounts && settings.jito.tipAccounts.length > 0)
      ? settings.jito.tipAccounts
      : [
          'Cw8CFyM9FxyqyPbS7WvB6K8vTXL8f5uR36Dq79RgnBKy',
          'DttWaMuZ9ST4itv7NreTC99vY56unz7FcPjs1461g4U6',
          '3AVYuyS2mYvSbiu9D95zS95yfB2LdHaH6p1TUnG9K2U3',
          'HFqU5x63VTqyUv6nBp6tWN6nU9Xh7hF6R3vJ2vG9K2U3',
        ];
    const randomTipAccount = new PublicKey(jitoTipAccounts[Math.floor(Math.random() * jitoTipAccounts.length)]);
    const tipAmountLamports = solToLamports(settings.jito.tipAmount);

    const tipInstruction = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: randomTipAccount,
      lamports: tipAmountLamports,
    });

    // Fetch ALTs if the transaction uses them
    let addressLookupTableAccounts = [];
    if (tx.message.addressTableLookups && tx.message.addressTableLookups.length > 0) {
      logger.debug('Fetching ALTs for Jito tip injection...');
      const connection = solana.getExecutionConnection();
      const altPromises = tx.message.addressTableLookups.map(async (lookup) => {
        const res = await connection.getAddressLookupTable(lookup.accountKey);
        return res.value;
      });
      const resolved = await Promise.all(altPromises);
      addressLookupTableAccounts = resolved.filter(Boolean);
    }

    // Re-build transaction message to include the tip
    const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts });
    message.instructions.push(tipInstruction);
    tx.message = message.compileToV0Message(addressLookupTableAccounts);
    
    // Sign the modified transaction
    tx.sign([wallet]);

    // 3. Send via Dedicated Sender Path (Helius Sender supports Jito txs)
    const rawTxBase64 = Buffer.from(tx.serialize()).toString('base64');
    logger.debug(`Sending Jito-tipped transaction via Helius Sender...`);
    const signature = await solana.submitViaSender(rawTxBase64);

    // Verify confirmation asynchronously
    solana.getExecutionConnection().confirmTransaction(signature, 'confirmed').catch(e => logger.warn(`Jito tx confirmation warning: ${e.message}`));
    
    return signature;
  }


  /**
   * Check if we can still buy (position limits, daily loss, etc.)
   */
  canBuy(currentPositions, dailyLoss) {
    if (!settings.trading.autoBuyEnabled) {
      return { allowed: false, reason: 'Auto-buy is disabled' };
    }

    if (currentPositions >= settings.trading.maxConcurrentPositions) {
      return { allowed: false, reason: `Max positions reached (${currentPositions}/${settings.trading.maxConcurrentPositions})` };
    }

    if (dailyLoss >= settings.trading.dailyLossLimitSol) {
      return { allowed: false, reason: `Daily loss limit reached (${formatSol(dailyLoss)}/${formatSol(settings.trading.dailyLossLimitSol)})` };
    }

    return { allowed: true };
  }

  /**
   * Universal Fallback executing buy via Jupiter V6 API
   */
  async _buyWithJupiter(mint, solAmount, wallet) {
    logger.info(`⚡ Hybrid Router: Executing Buy via Jupiter for ${mint}`);
    const lamports = solToLamports(solAmount);
    
    // 1. Get Snipe Quote
    const jupApiUrl = 'https://api.jup.ag/swap/v1';
    const quoteRes = await this.axiosInstance.get(`${jupApiUrl}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint}&amount=${lamports}&slippageBps=${settings.trading.buySlippage * 100}`);
    
    if (!quoteRes.data) throw new Error('Jupiter API Quote failed');

    const jupTipLamports = settings.jito.enabled ? Math.floor(settings.jito.tipAmount * 1e9) : 0;
    
    // 2. Build Transaction
    const swapRes = await this.axiosInstance.post(`${jupApiUrl}/swap`, {
      quoteResponse: quoteRes.data,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 1000 // Minimal fee, Jito will handle the main bribe
    });

    if (!swapRes.data || !swapRes.data.swapTransaction) throw new Error('🔌 Jupiter Swap failed to build transaction payload');

    const txBuffer = Buffer.from(swapRes.data.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuffer);

    // 3. Tip Injection for MEV Protection
    if (settings.jito.enabled) {
      const tipInstruction = SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(settings.jito.tipAccounts[Math.floor(Math.random() * settings.jito.tipAccounts.length)]),
        lamports: jupTipLamports,
      });

      let addressLookupTableAccounts = [];
      if (tx.message.addressTableLookups && tx.message.addressTableLookups.length > 0) {
        logger.debug('Fetching ALTs for Jupiter tip injection...');
        const connection = solana.getExecutionConnection();
        const altPromises = tx.message.addressTableLookups.map(async (lookup) => {
          const res = await connection.getAddressLookupTable(lookup.accountKey);
          return res.value;
        });
        const resolved = await Promise.all(altPromises);
        addressLookupTableAccounts = resolved.filter(Boolean);
      }

      const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts });
      message.instructions.push(tipInstruction);
      tx.message = message.compileToV0Message(addressLookupTableAccounts);
    }
    
    tx.sign([wallet]);

    // 4. Submit to Fast Route
    const rawTxBase64 = Buffer.from(tx.serialize()).toString('base64');
    logger.debug(`Sending Jupiter-built transaction via Helius Sender...`);
    const signature = await solana.submitViaSender(rawTxBase64);

    solana.getExecutionConnection().confirmTransaction(signature, 'confirmed').catch(() => {});
    return signature;
  }
}

module.exports = new BuyExecutor();
