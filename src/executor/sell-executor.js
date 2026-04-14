const { VersionedTransaction, SystemProgram, PublicKey, TransactionMessage } = require('@solana/web3.js');
const axios = require('axios');
const http = require('http');
const https = require('https');
const { SolanaConnection: solana, RPC_CATEGORY } = require('../core/solana-connection');
const settings = require('../config/settings');
const logger = require('../utils/logger');
const { formatSol, shortenAddress } = require('../utils/helpers');
const tradeTracker = require('../tracker/trade-tracker');
const priceService = require('../services/price-service');

class SellExecutor {
  constructor() {
    this.positions = new Map(); // mint -> { buyPrice, buyAmount, tokenAmount, timestamp }
    this.monitorIntervals = new Map();
    this.axiosInstance = axios.create({
      httpAgent: new http.Agent({ keepAlive: true }),
      httpsAgent: new https.Agent({ keepAlive: true }),
      timeout: 15000,
    });
  }

  /**
   * Load open positions from DB on startup
   */
  init() {
    logger.info('📦 Loading open real positions from database...');
    try {
      const openPositions = tradeTracker.getOpenRealPositions();
      for (const pos of openPositions) {
        this.positions.set(pos.mint, {
          buyAmountSol: pos.buy_amount_sol,
          entryMarketCapSol: pos.entry_market_cap_sol || pos.highest_market_cap_sol || 0,
          tokenAmount: pos.token_amount || 0,
          timestamp: pos.entry_timestamp,
          highestMarketCap: pos.highest_market_cap_sol || 0,
          signature: pos.signature,
          tokenSymbol: pos.token_symbol,
          tokenName: pos.token_name,
        });
        this.startMonitoring(pos.mint);
      }
      logger.info(`✅ Loaded ${openPositions.length} positions from DB.`);
    } catch (err) {
      logger.error(`Failed to load positions from DB: ${err.message}`);
    }
  }

  /**
   * Execute sell on PumpFun bonding curve
   */
  async sellToken(mint, tokenAmountPercent = 100) {
    const wallet = solana.getWallet();
    if (!wallet) throw new Error('No wallet configured');

    const position = this.positions.get(mint);
    if (position && position.isSelling && tokenAmountPercent >= 100) {
      logger.warn(`⚠️ Already selling ${mint}, skipping concurrent call.`);
      return { success: false, error: 'Already selling' };
    }

    if (position) position.isSelling = true;

    logger.info(`🔄 Selling ${tokenAmountPercent}% of ${mint}`);

    try {
      let signature;
      try {
        // 1. Try Jupiter first (User Priority)
        signature = await this._sellWithJupiter(mint, tokenAmountPercent, wallet);
      } catch (jupErr) {
        // 2. Fallback to PumpPortal if Jupiter fails
        logger.warn(`Jupiter sell failed or not indexed for ${mint}: ${jupErr.message}. Falling back to PumpPortal...`);
        signature = await this._sellDirect(mint, tokenAmountPercent, wallet);
      }

      // Clean up position tracking & Persist to DB
      if (tokenAmountPercent >= 100) {
        this.stopMonitoring(mint);
        this.positions.delete(mint);
        tradeTracker.closeRealPosition(mint);
      }

      return { success: true, signature, mint, timestamp: Date.now() };
    } catch (err) {
      logger.error(`❌ Sell failed for ${mint}: ${err.message}`);
      const pos = this.positions.get(mint);
      if (pos) pos.isSelling = false;
      return { success: false, error: err.message, mint, timestamp: Date.now() };
    }
  }

  async _sellDirect(mint, tokenAmountPercent, wallet) {
    const response = await this.axiosInstance.post('https://pumpportal.fun/api/trade-local', {
      publicKey: wallet.publicKey.toBase58(),
      action: 'sell',
      mint,
      amount: `${tokenAmountPercent}%`,
      denominatedInSol: 'false',
      slippage: settings.trading.sellSlippage,
      priorityFee: 0.0005,
      pool: 'pump',
    }, { responseType: 'arraybuffer' });

    if (!response.data) throw new Error('No transaction data from PumpPortal');

    const txBuffer = Buffer.from(response.data);
    const tx = VersionedTransaction.deserialize(txBuffer);
    if (settings.jito.enabled) {
      // Add Jito Tip instruction
      const jitoTipAccounts = (settings.jito.tipAccounts && settings.jito.tipAccounts.length > 0)
        ? settings.jito.tipAccounts
        : [
            'Cw8CFyM9FxyqyPbS7WvB6K8vTXL8f5uR36Dq79RgnBKy',
            'DttWaMuZ9ST4itv7NreTC99vY56unz7FcPjs1461g4U6',
            '3AVYuyS2mYvSbiu9D95zS95yfB2LdHaH6p1TUnG9K2U3',
            'HFqU5x63VTqyUv6nBp6tWN6nU9Xh7hF6R3vJ2vG9K2U3',
          ];
      const randomTipAccount = new PublicKey(jitoTipAccounts[Math.floor(Math.random() * jitoTipAccounts.length)]);
      const tipAmountLamports = Math.floor(settings.jito.tipAmount * 1e9);

      const tipInstruction = SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: randomTipAccount,
        lamports: tipAmountLamports,
      });

      // Fetch ALTs if the transaction uses them
      let addressLookupTableAccounts = [];
      if (tx.message.addressTableLookups && tx.message.addressTableLookups.length > 0) {
        logger.debug('Fetching ALTs for Jito tip injection in sell...');
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
      logger.debug('Added Jito Tip instruction to sell transaction');
    }

    tx.sign([wallet]);

    const rawTxBase64 = Buffer.from(tx.serialize()).toString('base64');
    const signature = await solana.submitViaSender(rawTxBase64);

    // Confirm asynchronously securely
    solana.getExecutionConnection().confirmTransaction(signature, 'confirmed').catch(e => logger.warn(`Confirmation error: ${e.message}`));
    logger.info(`✅ Sell executed via PumpPortal: ${signature}`);
    return signature;
  }

  async _sellWithJupiter(mint, tokenAmountPercent, wallet) {
    logger.info(`⚡ Hybrid Router: Executing Sell via Jupiter for ${mint}`);
    // 1. Get exact token balance required by Jupiter
    const parsedTokenAccounts = await solana.execute(conn => conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) }), RPC_CATEGORY.METADATA);
    let tokenBalanceLamports = 0;
    if (parsedTokenAccounts.value.length > 0) {
      tokenBalanceLamports = parsedTokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
    }
    
    if (tokenBalanceLamports == 0) throw new Error('No token balance found to sell');

    // Apply percentage
    const sellAmountLamports = Math.floor((parseInt(tokenBalanceLamports) * tokenAmountPercent) / 100);

    // 2. Get Quote
    const jupApiUrl = 'https://api.jup.ag/swap/v1';
    const quoteRes = await this.axiosInstance.get(`${jupApiUrl}/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=${sellAmountLamports}&slippageBps=${settings.trading.sellSlippage * 100}`);
    
    if (!quoteRes.data) throw new Error('Jupiter API Quote failed');

    const jupTipLamports = settings.jito.enabled ? Math.floor(settings.jito.tipAmount * 1e9) : 0;
    
    // 3. Build Transaction
    const swapRes = await this.axiosInstance.post(`${jupApiUrl}/swap`, {
      quoteResponse: quoteRes.data,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 1000
    });

    if (!swapRes.data || !swapRes.data.swapTransaction) throw new Error('🔌 Jupiter Swap failed to build transaction payload');

    const txBuffer = Buffer.from(swapRes.data.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuffer);

    // 4. Tip Injection
    if (settings.jito.enabled) {
      const tipInstruction = SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(settings.jito.tipAccounts[Math.floor(Math.random() * settings.jito.tipAccounts.length)]),
        lamports: jupTipLamports,
      });

      const execConnection = solana.getExecutionConnection();
      let addressLookupTableAccounts = [];
      if (tx.message.addressTableLookups && tx.message.addressTableLookups.length > 0) {
        logger.debug('Fetching ALTs for Jupiter tip injection...');
        const altPromises = tx.message.addressTableLookups.map(async (lookup) => {
          const res = await execConnection.getAddressLookupTable(lookup.accountKey);
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

    // 5. Submit to Fast Route
    const rawTxBase64 = Buffer.from(tx.serialize()).toString('base64');
    logger.debug(`Sending Jupiter-built transaction via Helius Sender...`);
    const signature = await solana.submitViaSender(rawTxBase64);

    solana.getExecutionConnection().confirmTransaction(signature, 'confirmed').catch(() => {});
    logger.info(`✅ Sell executed via Jupiter: ${signature}`);
    return signature;
  }

  /**
   * Register a new position for monitoring
   */
  addPosition(mint, buyData) {
    const position = {
      buyAmountSol: buyData.solAmount,
      entryMarketCapSol: buyData.marketCapSol || 0,
      tokenAmount: buyData.tokenAmount || 0,
      timestamp: buyData.timestamp || Date.now(),
      highestMarketCap: buyData.marketCapSol || 0,
      signature: buyData.signature || null,
      tokenSymbol: buyData.tokenSymbol || shortenAddress(mint),
      tokenName: buyData.tokenName || 'Unknown',
    };

    this.positions.set(mint, position);

    // Persist to DB
    tradeTracker.recordRealPositionOpen({
      mint,
      tokenSymbol: position.tokenSymbol,
      tokenName: position.tokenName,
      buyAmountSol: position.buyAmountSol,
      tokenAmount: position.tokenAmount,
      entryMarketCapSol: position.entryMarketCapSol,
      signature: position.signature,
      entryTimestamp: position.timestamp
    });

    logger.info(`Position added: ${mint} @ ${formatSol(buyData.solAmount)}`);
  }

  /**
   * Sync all positions with actual wallet balances.
   * PERFORMANCE UPGRADE: Performs Deep Discovery scanning the whole wallet for new tokens.
   */
  async syncWithWallet() {
    logger.info('🔄 Ultimate Sync: Scanning wallet for all Legacy and Token-2022 positions...');
    try {
      const wallet = solana.getWallet();
      if (!wallet) throw new Error('No wallet configured');

      const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbAtY99qz97CeeS8oWpSSTN623VQ5DA');

      // 1. Fetch ALL SPL Token Accounts for BOTH programs in parallel
      const scanResults = await Promise.allSettled([
        solana.execute(conn => conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }), RPC_CATEGORY.METADATA),
        solana.execute(conn => conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID }), RPC_CATEGORY.METADATA)
      ]);

      const allAccounts = [];
      scanResults.forEach((res, index) => {
        if (res.status === 'fulfilled' && res.value?.value) {
          allAccounts.push(...res.value.value);
          logger.debug(`Found ${res.value.value.length} accounts in Program ${index === 0 ? 'Legacy' : 'Token-2022'}`);
        } else if (res.status === 'rejected') {
          logger.warn(`Scan for Program ${index === 0 ? 'Legacy' : 'Token-2022'} failed: ${res.reason?.message}`);
        }
      });

      if (allAccounts.length === 0) {
        logger.warn('No token accounts found for this wallet in either program.');
      }

      const discoveredMints = new Set();
      let addedCount = 0;
      let removedCount = 0;

      // 2. Map existing tracked accounts
      const currentTracked = Array.from(this.positions.keys());

      // 3. Process each on-chain token account
      for (const account of allAccounts) {
        const mint = account.account.data.parsed.info.mint;
        const balance = account.account.data.parsed.info.tokenAmount.uiAmount || 0;
        discoveredMints.add(mint);

        if (balance > 0) {
          if (!this.positions.has(mint)) {
            // DEEP DISCOVERY: Found a token in wallet that we aren't tracking
            logger.info(`🔍 Ultimate Discovery found token: ${mint} with balance ${balance}`);
            
            // Try to fetch metadata
            let tokenName = 'Discovered Token';
            let tokenSymbol = shortenAddress(mint);
            let mcap = 0;

            try {
              const pairs = await priceService.getTokensData([mint]);
              const bestPair = priceService.selectBestPairForMint(pairs, mint);
              if (bestPair) {
                tokenName = bestPair.baseToken.name;
                tokenSymbol = bestPair.baseToken.symbol;
                mcap = (parseFloat(bestPair.fdv) || 0) / (await priceService.getSolPrice() || 150);
              }
            } catch (e) {
              logger.debug(`Metadata fetch failed for discovered token ${mint}: ${e.message}`);
            }

            this.addPosition(mint, {
              solAmount: 0, // Unknown entry for discovered tokens
              tokenAmount: balance,
              tokenSymbol,
              tokenName,
              marketCapSol: mcap,
              timestamp: Date.now()
            });
            this.startMonitoring(mint);
            addedCount++;
          } else {
            // Update balance for existing position
            const pos = this.positions.get(mint);
            if (pos) {
              pos.tokenAmount = balance;
              // Sync DB too
              tradeTracker.updateRealPositionSnapshot({
                mint,
                tokenAmount: balance,
                currentMarketCapSol: pos.highestMarketCap || 0
              });
            }
          }
        }
      }

      // 4. Remove tracked tokens that are no longer in the wallet (Discovery confirmed 0)
      for (const trackedMint of currentTracked) {
        if (!discoveredMints.has(trackedMint)) {
          logger.info(`🗑️ Tracker cleanup: ${trackedMint} no longer found in wallet. Removing.`);
          this.stopMonitoring(trackedMint);
          this.positions.delete(trackedMint);
          tradeTracker.closeRealPosition(trackedMint);
          removedCount++;
        }
      }

      logger.info(`✅ Ultimate Sync complete. Discovered: ${addedCount}, Cleaned: ${removedCount}, Total: ${this.positions.size}`);
      return { success: true, addedCount, removedCount, totalRemaining: this.positions.size };

    } catch (err) {
      logger.error(`Ultimate Sync failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Get all currently open positions for UI display
   */
  getPositions() {
    const arr = [];
    for (const [mint, pos] of this.positions.entries()) {
      arr.push({
        mint,
        ...pos
      });
    }
    return arr.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Start monitoring a position for TP/SL/Anti-rug
   */
  startMonitoring(mint, onTradeCallback) {
    if (this.monitorIntervals.has(mint)) return;

    const position = this.positions.get(mint);
    if (!position) return;

    logger.info(`📊 Monitoring position: ${mint}`);

    // The monitoring is event-driven via PumpFun WebSocket trades
    // This method sets up the callback for trade events
    this.monitorIntervals.set(mint, {
      callback: onTradeCallback,
      startTime: Date.now(),
    });
  }

  /**
   * Process a trade event for a monitored position
   * Called by the orchestrator when a trade event arrives
   */
  async processTradeEvent(tradeData) {
    const mint = tradeData.mint;
    const position = this.positions.get(mint);
    if (!position || position.isSelling) return null;

    const currentValueSol = tradeData.vSolInBondingCurve || 0;
    const currentMarketCap = tradeData.newMarketCapSol || 0;

    // Update highest market cap
    if (currentMarketCap > position.highestMarketCap) {
      position.highestMarketCap = currentMarketCap;
    }

    // Calculate PnL (compare current market cap against market cap at entry)
    const pnlPercent = position.entryMarketCapSol > 0
      ? ((currentMarketCap - position.entryMarketCapSol) / position.entryMarketCapSol) * 100
      : 0;

    // Check Take Profit
    if (pnlPercent >= settings.risk.takeProfitPercent) {
      if (!settings.trading.autoSellEnabled) {
        logger.info(`🎯 TP reached for ${mint}: +${pnlPercent.toFixed(1)}% but Auto-Sell is OFF`);
        return null;
      }
      position.isSelling = true;
      const pnlSol = (position.buyAmountSol || 0) * (pnlPercent / 100);
      return { action: 'SELL', reason: 'TAKE_PROFIT', pnlPercent, pnlSol, mint };
    }

    // Check Stop Loss
    if (pnlPercent <= -settings.risk.stopLossPercent) {
      if (!settings.trading.autoSellEnabled) {
        logger.info(`🛑 SL reached for ${mint}: ${pnlPercent.toFixed(1)}% but Auto-Sell is OFF`);
        return null;
      }
      position.isSelling = true;
      const pnlSol = (position.buyAmountSol || 0) * (pnlPercent / 100);
      return { action: 'SELL', reason: 'STOP_LOSS', pnlPercent, pnlSol, mint };
    }

    return null; // No action needed
  }

  /**
   * Periodic safety check for SL/TP using price service
   * This handles cases where PumpFun volume dies or trade events are missed
   */
  async checkSafetyStopLosses() {
    if (this.positions.size === 0) return [];

    const mints = Array.from(this.positions.keys());
    logger.debug(`🛡️ Running Safety SL/TP check for ${mints.length} positions...`);

    try {
      const [allPairs, solPrice] = await Promise.all([
        priceService.getTokensData(mints),
        priceService.getSolPrice()
      ]);

      const actions = [];
      for (const mint of mints) {
        const position = this.positions.get(mint);
        if (!position || position.isSelling) continue;

        const bestPair = priceService.selectBestPairForMint(allPairs, mint);
        if (!bestPair) {
          logger.debug(`Safety check: No pair found for ${shortenAddress(mint)} yet.`);
          continue;
        }

        // Calculate current MC in SOL
        const currentMcapUsd = parseFloat(bestPair.fdv || bestPair.marketCap || 0);
        const currentMcapSol = currentMcapUsd / (solPrice || 150);

        if (currentMcapSol === 0) continue;

        // Update highest MC
        if (currentMcapSol > position.highestMarketCap) {
          position.highestMarketCap = currentMcapSol;
        }

        // Calculate PnL
        const pnlPercent = position.entryMarketCapSol > 0
          ? ((currentMcapSol - position.entryMarketCapSol) / position.entryMarketCapSol) * 100
          : 0;

        // Check TP
        if (pnlPercent >= settings.risk.takeProfitPercent) {
          if (!settings.trading.autoSellEnabled) {
            logger.info(`🎯 Safety: TP reached for ${shortenAddress(mint)}: +${pnlPercent.toFixed(1)}% (Auto-Sell OFF)`);
            continue;
          }
          const pnlSol = (position.buyAmountSol || 0) * (pnlPercent / 100);
          actions.push({ action: 'SELL', reason: 'TAKE_PROFIT', pnlPercent, pnlSol, mint, safety: true });
        }
        // Check SL
        else if (pnlPercent <= -settings.risk.stopLossPercent) {
          if (!settings.trading.autoSellEnabled) {
            logger.info(`🛑 Safety: SL reached for ${shortenAddress(mint)}: ${pnlPercent.toFixed(1)}% (Auto-Sell OFF)`);
            continue;
          }
          const pnlSol = (position.buyAmountSol || 0) * (pnlPercent / 100);
          actions.push({ action: 'SELL', reason: 'STOP_LOSS', pnlPercent, pnlSol, mint, safety: true });
        }
      }

      return actions;
    } catch (err) {
      logger.error(`Safety SL check failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Stop monitoring a position
   */
  stopMonitoring(mint) {
    this.monitorIntervals.delete(mint);
    logger.debug(`Stopped monitoring: ${mint}`);
  }

  getPositionCount() {
    return this.positions.size;
  }

  /**
   * Clear all positions and stop monitoring
   */
  clearAllPositions() {
    // Stop all monitor intervals
    for (const mint of this.monitorIntervals.keys()) {
      this.stopMonitoring(mint);
    }
    
    // Clear maps
    this.positions.clear();
    this.monitorIntervals.clear();
    
    logger.info('📦 All in-memory positions and monitors have been cleared.');
  }
}

module.exports = new SellExecutor();
