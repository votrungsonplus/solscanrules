const WebSocket = require('ws');
const EventEmitter = require('events');
const settings = require('../config/settings');
const logger = require('../utils/logger');

class PumpFunDetector extends EventEmitter {
  constructor() {
    super();
    this.streams = [];
    this.isRunning = false;
    this._subscribedTokens = new Set();
    this._seenCreates = new Map();
    this._seenTrades = new Map();
    this._dedupeTTL = 5 * 60 * 1000;
    this._dedupeCleanupTimer = null;
  }

  start() {
    this.isRunning = true;

    const primaryUrl = settings.pumpfun.wsUrl;
    this._openStream('primary', primaryUrl);

    if (settings.pumpfun.wsUrl) {
      this._openStream('shadow', primaryUrl);
    }

    this._startDedupeCleanup();
    logger.info(`PumpFun detector started (${this.streams.length} parallel WS streams with dedupe)`);
  }

  stop() {
    this.isRunning = false;
    for (const stream of this.streams) {
      try { stream.ws && stream.ws.close(); } catch (e) { /* ignore */ }
    }
    this.streams = [];
    if (this._dedupeCleanupTimer) clearInterval(this._dedupeCleanupTimer);
    this._dedupeCleanupTimer = null;
    logger.info('PumpFun detector stopped');
  }

  _openStream(name, url) {
    const stream = {
      name,
      url,
      ws: null,
      reconnectAttempts: 0,
      maxReconnectAttempts: 10,
    };
    this.streams.push(stream);
    this._connectStream(stream);
  }

  _connectStream(stream) {
    stream.ws = new WebSocket(stream.url);

    stream.ws.on('open', () => {
      logger.info(`Connected to PumpFun WebSocket [${stream.name}]`);
      stream.reconnectAttempts = 0;

      stream.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));

      if (this._subscribedTokens.size > 0) {
        const keys = Array.from(this._subscribedTokens);
        logger.info(`[${stream.name}] Re-subscribing to ${keys.length} tokens`);
        stream.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys }));
      }
    });

    stream.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this._handleMessage(message, stream.name);
      } catch (err) {
        logger.error(`[${stream.name}] Failed to parse PumpFun message: ${err.message}`);
      }
    });

    stream.ws.on('close', () => {
      logger.warn(`[${stream.name}] PumpFun WebSocket closed`);
      this._reconnectStream(stream);
    });

    stream.ws.on('error', (err) => {
      logger.error(`[${stream.name}] PumpFun WebSocket error: ${err.message}`);
    });
  }

  _reconnectStream(stream) {
    if (!this.isRunning) return;
    if (stream.reconnectAttempts >= stream.maxReconnectAttempts) {
      logger.error(`[${stream.name}] Max reconnect attempts reached. Auto-recovery in 60s...`);
      if (stream.name === 'primary') this.emit('disconnected');
      setTimeout(() => {
        if (!this.isRunning) return;
        logger.info(`🔄 [${stream.name}] Auto-recovery: reconnecting...`);
        stream.reconnectAttempts = 0;
        this._connectStream(stream);
      }, 60000);
      return;
    }
    stream.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, stream.reconnectAttempts), 30000);
    logger.info(`[${stream.name}] Reconnecting in ${delay}ms (attempt ${stream.reconnectAttempts})`);
    setTimeout(() => this._connectStream(stream), delay);
  }

  _handleMessage(message, streamName) {
    if (message.txType === 'create') {
      const dedupeKey = message.signature || `${message.mint}-${message.traderPublicKey}`;
      if (this._seenCreates.has(dedupeKey)) return;
      this._seenCreates.set(dedupeKey, Date.now());

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

      logger.info(`🆕 [${streamName}] New token: ${tokenData.symbol} (${tokenData.mint}) | MCap: ${marketCapSol.toFixed(2)} SOL`);
      this.emit('newToken', tokenData);
      return;
    }

    if (message.txType === 'buy' || message.txType === 'sell') {
      const dedupeKey = message.signature || `${message.mint}-${message.traderPublicKey}-${message.timestamp || ''}`;
      if (this._seenTrades.has(dedupeKey)) return;
      this._seenTrades.set(dedupeKey, Date.now());

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

  _startDedupeCleanup() {
    if (this._dedupeCleanupTimer) return;
    this._dedupeCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - this._dedupeTTL;
      for (const [k, t] of this._seenCreates) if (t < cutoff) this._seenCreates.delete(k);
      for (const [k, t] of this._seenTrades) if (t < cutoff) this._seenTrades.delete(k);
    }, 60000);
  }

  subscribeToToken(mint) {
    this._subscribedTokens.add(mint);
    for (const stream of this.streams) {
      if (stream.ws && stream.ws.readyState === WebSocket.OPEN) {
        stream.ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
      }
    }
    logger.debug(`Subscribed ${this.streams.length} stream(s) to trades for ${mint}`);
  }

  unsubscribeFromToken(mint) {
    this._subscribedTokens.delete(mint);
    for (const stream of this.streams) {
      if (stream.ws && stream.ws.readyState === WebSocket.OPEN) {
        stream.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
      }
    }
  }

  cleanupSubscriptions(activeMints) {
    const activeSet = new Set(activeMints);
    const toRemove = [];
    for (const mint of this._subscribedTokens) {
      if (!activeSet.has(mint)) toRemove.push(mint);
    }
    if (toRemove.length === 0) return;
    for (const mint of toRemove) this._subscribedTokens.delete(mint);
    for (const stream of this.streams) {
      if (stream.ws && stream.ws.readyState === WebSocket.OPEN) {
        stream.ws.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: toRemove }));
      }
    }
    logger.debug(`Cleaned up ${toRemove.length} token subscriptions across ${this.streams.length} streams`);
  }

  getStreamStatus() {
    return this.streams.map(s => ({
      name: s.name,
      state: s.ws ? ['CONNECTING','OPEN','CLOSING','CLOSED'][s.ws.readyState] : 'NONE',
      attempts: s.reconnectAttempts,
    }));
  }
}

module.exports = new PumpFunDetector();
