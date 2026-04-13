const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');
const axios = require('axios');
const settings = require('../config/settings');
const logger = require('../utils/logger');

const RPC_CATEGORY = {
  GENERAL: 'GENERAL',     // Tác vụ chung, số dư, fallback cuối cùng
  DETECTION: 'DETECTION', // Theo dõi token mới, sự kiện PumpFun
  ANALYSIS: 'ANALYSIS',   // Phân tích ví nặng (lịch sử giao dịch, signatures)
  METADATA: 'METADATA',   // Quét chủ sở hữu (holders), thông tin contract
  TRADING: 'TRADING'      // Thực thi lệnh và xác nhận giao dịch
};

class SolanaConnection {
  constructor() {
    this.connections = [];
    this.executionConnection = null;
    this.wallet = null;

    // Round-robin counter cho fallback chung
    this._rrIndex = 0;

    // Phân bổ danh mục RPC
    this._categoryIndices = {
      [RPC_CATEGORY.DETECTION]: [0], // RPC 1 (Helius)
      [RPC_CATEGORY.ANALYSIS]: [1],  // RPC 2 (Alchemy)
      [RPC_CATEGORY.METADATA]: [2],  // RPC 3 (Helius #2)
      [RPC_CATEGORY.GENERAL]: [3],   // RPC 4 (QuickNode)
      [RPC_CATEGORY.TRADING]: [0],   // Ưu tiên Helius
    };

    this._endpointStats = [];
    this._maxPerEndpoint = parseInt(process.env.RPC_MAX_PER_ENDPOINT || '10', 10);
    this._minSpacingMs = parseInt(process.env.RPC_MIN_SPACING_MS || '50', 10);
  }

  init() {
    for (const url of settings.rpcUrls) {
      const conn = new Connection(url, {
        commitment: 'confirmed',
        wsEndpoint: settings.wsUrl,
        disableRetryOnRateLimit: true,
      });
      this.connections.push(conn);
      this._endpointStats.push({
        inFlight: 0,
        lastRequestTime: 0,
        errorCount: 0,
        lastErrorTime: 0,
        cooldownUntil: 0,
      });
      logger.info(`RPC #${this.connections.length}: ${url.substring(0, 50)}...`);
    }

    // Tự động phân bổ nếu số lượng RPC khác 4
    this._autoAssignCategories();

    const totalRps = this.connections.length * Math.floor(1000 / this._minSpacingMs);
    logger.info(`RPC Optimized Pool: ${this.connections.length} endpoints | ~${totalRps} req/s total | Categorized Failover Active`);

    if (settings.heliusExecutionRpcUrl) {
      this.executionConnection = new Connection(settings.heliusExecutionRpcUrl, {
        commitment: 'confirmed',
        disableRetryOnRateLimit: true,
      });
      logger.info('🚀 Dedicated Execution RPC initialized (Helius)');
    }

    if (settings.walletPrivateKey) {
      try {
        let secretKey;
        const keyStr = settings.walletPrivateKey.trim();
        if (keyStr.startsWith('[') && keyStr.endsWith(']')) {
          secretKey = Uint8Array.from(JSON.parse(keyStr));
        } else {
          secretKey = bs58.decode(keyStr);
        }
        this.wallet = Keypair.fromSecretKey(secretKey);
        logger.info(`✅ Wallet Loaded: ${this.wallet.publicKey.toBase58()}`);
      } catch (err) {
        logger.error(`❌ Failed to load wallet: ${err.message}`);
        this.wallet = null;
      }
    }

    return this;
  }

  _autoAssignCategories() {
    const count = this.connections.length;
    if (count === 0) return;

    // Reset mapping
    Object.keys(this._categoryIndices).forEach(cat => {
      this._categoryIndices[cat] = [];
    });

    if (count === 1) {
      Object.keys(this._categoryIndices).forEach(cat => {
        this._categoryIndices[cat] = [0];
      });
    } else if (count === 2) {
      this._categoryIndices[RPC_CATEGORY.DETECTION] = [0];
      this._categoryIndices[RPC_CATEGORY.TRADING] = [0];
      this._categoryIndices[RPC_CATEGORY.ANALYSIS] = [1];
      this._categoryIndices[RPC_CATEGORY.METADATA] = [1];
      this._categoryIndices[RPC_CATEGORY.GENERAL] = [0, 1];
    } else if (count >= 4) {
      this._categoryIndices[RPC_CATEGORY.DETECTION] = [0];
      this._categoryIndices[RPC_CATEGORY.TRADING] = [0];
      this._categoryIndices[RPC_CATEGORY.ANALYSIS] = [1];
      this._categoryIndices[RPC_CATEGORY.METADATA] = [2];
      this._categoryIndices[RPC_CATEGORY.GENERAL] = [0, 1, 2, 3]; // Phân bổ đều cho các RPC thay vì chỉ RPC #4
    } else {
      // 3 RPCs
      this._categoryIndices[RPC_CATEGORY.DETECTION] = [0];
      this._categoryIndices[RPC_CATEGORY.TRADING] = [0];
      this._categoryIndices[RPC_CATEGORY.ANALYSIS] = [1];
      this._categoryIndices[RPC_CATEGORY.METADATA] = [2];
      this._categoryIndices[RPC_CATEGORY.GENERAL] = [0, 1, 2];
    }
  }

  _nextEndpoint(category = 'GENERAL') {
    const now = Date.now();
    const primaryIndices = this._categoryIndices[category] || this._categoryIndices[RPC_CATEGORY.GENERAL];
    
    // 1. Thử các RPC được chỉ định cho category này trước
    for (const idx of primaryIndices) {
      const s = this._endpointStats[idx];
      if (s.cooldownUntil < now) return idx;
    }

    // 2. Nếu tất cả RPC trong mảng này bận/lỗi, thử xoay vòng toàn bộ pool (Fast Failover)
    const count = this.connections.length;
    for (let i = 0; i < count; i++) {
        const idx = this._rrIndex % count;
        this._rrIndex++;
        if (this._endpointStats[idx].cooldownUntil < now) return idx;
    }

    // 3. Nếu mọi thứ đều cooldown, chọn cái có thời gian lỗi xa nhất
    let oldestIdx = 0;
    let oldestTime = Infinity;
    for (let i = 0; i < count; i++) {
      if (this._endpointStats[i].lastErrorTime < oldestTime) {
        oldestTime = this._endpointStats[i].lastErrorTime;
        oldestIdx = i;
      }
    }
    return oldestIdx;
  }

  async execute(fn, category = RPC_CATEGORY.GENERAL) {
    if (!this.connections.length) throw new Error('No RPC connections');

    const tried = new Set();
    const RPC_TIMEOUT = 12000;

    while (tried.size < this.connections.length) {
      const idx = this._nextEndpoint(category);

      if (tried.has(idx)) {
        // Force pick unexplored
        let found = false;
        for (let i = 0; i < this.connections.length; i++) {
          if (!tried.has(i)) {
            tried.add(i);
            await this._waitForSlot(i);
            try {
              return await this._withTimeout(fn(this.connections[i]), RPC_TIMEOUT, `RPC #${i + 1} [${category}]`);
            } catch (err) {
              this._markError(i, err);
              if (tried.size >= this.connections.length) throw err;
              found = true;
              break;
            } finally {
              this._releaseSlot(i);
            }
          }
        }
        if (!found) break;
        continue;
      }

      tried.add(idx);
      await this._waitForSlot(idx);

      try {
        return await this._withTimeout(fn(this.connections[idx]), RPC_TIMEOUT, `RPC #${idx + 1} [${category}]`);
      } catch (err) {
        this._markError(idx, err);
        const is429 = err.message && (err.message.includes('429') || err.message.includes('Too Many Requests'));
        if (is429) {
          logger.warn(`⚠️ RPC #${idx + 1} [${category}] bị Rate Limit (429). Đang thử lại ngay bằng RPC khác...`);
        }
        if (tried.size >= this.connections.length) throw err;
      } finally {
        this._releaseSlot(idx);
      }
    }
  }

  async executeRace(fn) {
    if (this.connections.length === 1) return this.execute(fn);
    const RPC_TIMEOUT = 8000;
    
    const promises = this.connections.map(async (conn, index) => {
      await this._waitForSlot(index);
      try {
        const result = await this._withTimeout(fn(conn), RPC_TIMEOUT, `RPC #${index + 1} Race`);
        return { result, index };
      } catch (err) {
        this._markError(index, err);
        throw err;
      } finally {
        this._releaseSlot(index);
      }
    });

    try {
      const { result } = await Promise.any(promises);
      return result;
    } catch (e) {
      throw e.errors ? e.errors[0] : e;
    }
  }

  async _waitForSlot(idx) {
    const stats = this._endpointStats[idx];
    while (true) {
      const now = Date.now();
      if (now - stats.lastRequestTime >= this._minSpacingMs && stats.inFlight < this._maxPerEndpoint) {
        stats.inFlight++;
        stats.lastRequestTime = now;
        return;
      }
      await new Promise(r => setTimeout(r, 10));
    }
  }

  _releaseSlot(idx) {
    this._endpointStats[idx].inFlight = Math.max(0, this._endpointStats[idx].inFlight - 1);
  }

  _markError(idx, error) {
    const stats = this._endpointStats[idx];
    stats.errorCount++;
    stats.lastErrorTime = Date.now();

    const errMsg = error?.message || String(error);
    if (errMsg.includes('limit reached') || errMsg.includes('daily request limit')) {
      logger.error(`🔴 RPC #${idx + 1} ĐÃ HẾT HẠN MỨC NGÀY. Tạm dừng 1 giờ.`);
      stats.cooldownUntil = Date.now() + 3600000;
    } else if (errMsg.includes('429')) {
      stats.cooldownUntil = Date.now() + 2000; // Nghỉ 2s nếu bị rate limit
    } else {
      stats.cooldownUntil = Date.now() + 1000;
    }
  }

  async _withTimeout(promise, ms, name) {
    let tid;
    const timeout = new Promise((_, r) => tid = setTimeout(() => r(new Error(`${name} timeout ${ms}ms`)), ms));
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(tid);
    }
  }

  // Các phương thức tiện ích
  async getBalance() {
    if (!this.wallet) return 0;
    return (await this.execute(c => c.getBalance(this.wallet.publicKey), RPC_CATEGORY.GENERAL)) / 1e9;
  }

  async getTokenBalance(mint) {
    if (!this.wallet) return 0;
    try {
      const mintPk = new PublicKey(mint);
      let res = await this.execute(c => c.getTokenAccountsByOwner(this.wallet.publicKey, { mint: mintPk }), RPC_CATEGORY.GENERAL);
      if (!res.value.length) {
        res = await this.execute(c => c.getTokenAccountsByOwner(this.wallet.publicKey, { 
            mint: mintPk, 
            programId: new PublicKey('TokenzQdBNbAtY99qz97CeeS8oWpSSTN623VQ5DA') 
        }), RPC_CATEGORY.GENERAL);
      }
      if (!res.value.length) return 0;
      const bal = await this.execute(c => c.getTokenAccountBalance(res.value[0].pubkey), RPC_CATEGORY.GENERAL);
      return bal?.value?.uiAmount ?? 0;
    } catch (e) {
      return 0;
    }
  }

  getWallet() { return this.wallet; }
  getPublicKey() { return this.wallet?.publicKey; }
  getExecutionConnection() { return this.executionConnection || this.connections[0]; }

  /**
   * Get wallet summary (address, balance)
   */
  async getWalletSummary() {
    if (!this.wallet) return null;
    try {
      const balance = await this.getBalance();
      return {
        address: this.wallet.publicKey.toBase58(),
        balance: balance
      };
    } catch (err) {
      return {
        address: this.wallet.publicKey.toBase58(),
        balance: 0
      };
    }
  }

  async submitViaSender(rawTxB64) {
    if (!settings.heliusSenderUrl) {
      return this.getExecutionConnection().sendRawTransaction(Buffer.from(rawTxB64, 'base64'), { skipPreflight: true });
    }
    try {
      const res = await axios.post(settings.heliusSenderUrl, {
        jsonrpc: '2.0', id: '1', method: 'sendTransaction', params: [rawTxB64, { encoding: 'base64', skipPreflight: true }]
      }, { timeout: 8000 });
      if (res.data.error) throw new Error(res.data.error.message);
      return res.data.result;
    } catch (e) {
      return this.getExecutionConnection().sendRawTransaction(Buffer.from(rawTxB64, 'base64'), { skipPreflight: true });
    }
  }
}

module.exports = {
  SolanaConnection: new SolanaConnection(),
  RPC_CATEGORY
};
