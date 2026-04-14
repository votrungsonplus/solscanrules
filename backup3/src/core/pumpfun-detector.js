const WebSocket = require('ws');
const EventEmitter = require('events');
const settings = require('../config/settings');
const logger = require('../utils/logger');
const { SolanaConnection: solana } = require('./solana-connection');

class PumpFunDetector extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.isRunning = false;
  }

  /**
   * Start listening for new token creation events on PumpFun
   * Uses PumpPortal WebSocket API for real-time detection
   */
  start() {
    this.isRunning = true;
    this._connect();
    logger.info('PumpFun detector started - listening for new tokens...');
  }

  stop() {
    this.isRunning = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('PumpFun detector stopped');
  }

  _connect() {
    this.ws = new WebSocket(settings.pumpfun.wsUrl);

    this.ws.on('open', () => {
      logger.info('Connected to PumpFun WebSocket');
      this.reconnectAttempts = 0;

      // Subscribe to new token creation events
      this.ws.send(JSON.stringify({
        method: 'subscribeNewToken',
      }));

      // Re-subscribe to tokens we were tracking before reconnect
      if (this._subscribedTokens && this._subscribedTokens.size > 0) {
        const keys = Array.from(this._subscribedTokens);
        logger.info(`Re-subscribing to ${keys.length} tokens after reconnect`);
        this.ws.send(JSON.stringify({
          method: 'subscribeTokenTrade',
          keys,
        }));
      }
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this._handleMessage(message);
      } catch (err) {
        logger.error(`Failed to parse PumpFun message: ${err.message}`);
      }
    });

    this.ws.on('close', () => {
      logger.warn('PumpFun WebSocket closed');
      this._reconnect();
    });

    this.ws.on('error', (err) => {
      logger.error(`PumpFun WebSocket error: ${err.message}`);
    });
  }

  _reconnect() {
    if (!this.isRunning) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached for PumpFun WebSocket');
      this.emit('disconnected');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    logger.info(`Reconnecting to PumpFun in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this._connect(), delay);
  }

  _handleMessage(message) {
    // New token created on PumpFun
    if (message.txType === 'create') {
      const { calculatePumpFunMcap } = require('../utils/helpers');
      const marketCapSol = calculatePumpFunMcap(message.vSolInBondingCurve, message.vTokensInBondingCurve) || message.marketCapSol || 0;

      const tokenData = {
        mint: message.mint,
        name: message.name || 'Unknown',
        symbol: message.symbol || 'UNKNOWN',
        deployer: message.traderPublicKey,
        timestamp: Date.now(),
        signature: message.signature,
        uri: message.uri || null,
        initialBuy: message.tokenAmount || 0,
        solAmount: message.solAmount || 0,
        marketCapSol,
        bondingCurveKey: message.bondingCurveKey || null,
        vTokensInBondingCurve: message.vTokensInBondingCurve || 0,
        vSolInBondingCurve: message.vSolInBondingCurve || 0,
      };

      logger.info(`🆕 New token: ${tokenData.symbol} (${tokenData.mint}) | Calculated MCap: ${marketCapSol.toFixed(2)} SOL`);
      this.emit('newToken', tokenData);
    }

    // Trade event on bonding curve
    if (message.txType === 'buy' || message.txType === 'sell') {
      const { calculatePumpFunMcap } = require('../utils/helpers');
      const marketCapSol = calculatePumpFunMcap(message.vSolInBondingCurve, message.vTokensInBondingCurve) || message.marketCapSol || 0;

      const tradeData = {
        mint: message.mint,
        txType: message.txType,
        trader: message.traderPublicKey,
        tokenAmount: message.tokenAmount || 0,
        solAmount: message.solAmount || 0,
        newMarketCapSol: marketCapSol,
        bondingCurveKey: message.bondingCurveKey || null,
        vTokensInBondingCurve: message.vTokensInBondingCurve || 0,
        vSolInBondingCurve: message.vSolInBondingCurve || 0,
        timestamp: Date.now(),
        signature: message.signature,
        slot: message.slot || null,
      };

      this.emit('trade', tradeData);
    }
  }

  /**
   * Subscribe to trades for a specific token mint
   */
  subscribeToToken(mint) {
    if (!this._subscribedTokens) this._subscribedTokens = new Set();
    this._subscribedTokens.add(mint);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        method: 'subscribeTokenTrade',
        keys: [mint],
      }));
      logger.debug(`Subscribed to trades for ${mint}`);
    }
  }

  /**
   * Unsubscribe from a specific token
   */
  unsubscribeFromToken(mint) {
    if (this._subscribedTokens) this._subscribedTokens.delete(mint);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        method: 'unsubscribeTokenTrade',
        keys: [mint],
      }));
    }
  }

  /**
   * Clean up old token subscriptions to prevent memory leak
   * Called periodically or when token count exceeds threshold
   */
  cleanupSubscriptions(activeMints) {
    if (!this._subscribedTokens) return;
    const activeSet = new Set(activeMints);
    const toRemove = [];
    for (const mint of this._subscribedTokens) {
      if (!activeSet.has(mint)) toRemove.push(mint);
    }
    if (toRemove.length > 0) {
      for (const mint of toRemove) this._subscribedTokens.delete(mint);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          method: 'unsubscribeTokenTrade',
          keys: toRemove,
        }));
      }
      logger.debug(`Cleaned up ${toRemove.length} token subscriptions`);
    }
  }
}

module.exports = new PumpFunDetector();
