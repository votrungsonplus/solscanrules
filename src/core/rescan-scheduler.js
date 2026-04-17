const logger = require('../utils/logger');
const { shortenAddress } = require('../utils/helpers');

const DEFAULT_MIN_INTERVAL = parseInt(process.env.RESCAN_MIN_INTERVAL_MS || '200', 10);
const DEFAULT_MAX_INTERVAL = parseInt(process.env.RESCAN_MAX_INTERVAL_MS || '3000', 10);

class RescanScheduler {
  constructor(orchestrator) {
    this.orch = orchestrator;
    this.pending = new Map();
    this.tickTimer = null;
    this.TICK_MS = 50;
    this.stats = { scheduled: 0, fired: 0, dropped: 0, rescheduled: 0 };
  }

  start() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      try { this._tick(); } catch (err) {
        logger.error(`RescanScheduler tick error: ${err.message}`);
      }
    }, this.TICK_MS);
    logger.info(`🌀 RescanScheduler started (tick=${this.TICK_MS}ms, range=${DEFAULT_MIN_INTERVAL}-${DEFAULT_MAX_INTERVAL}ms)`);
  }

  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.pending.clear();
  }

  schedule(mint, { reason = 'rescan', force = false } = {}) {
    if (!this.orch) return;
    const token = this.orch.tokenData.get(mint);
    if (!token) return;
    if (this.orch.passedTokens.has(mint)) return;

    const ageMs = Date.now() - token.timestamp;
    const maxAgeMs = (this.orch._getMaxAgeMinutes() || 5) * 60000;
    if (ageMs >= maxAgeMs) return;

    const interval = this._dynamicInterval(ageMs);
    const existing = this.pending.get(mint);
    const nextFireAt = Date.now() + interval;

    if (existing && !force && existing.nextFireAt <= nextFireAt) {
      return;
    }

    this.pending.set(mint, {
      mint,
      nextFireAt,
      priority: ageMs,
      reason,
      scheduledAt: Date.now(),
    });
    this.stats.scheduled++;
  }

  cancel(mint) {
    this.pending.delete(mint);
  }

  _dynamicInterval(ageMs) {
    if (ageMs < 30_000) return Math.max(DEFAULT_MIN_INTERVAL, 200);
    if (ageMs < 120_000) return Math.max(DEFAULT_MIN_INTERVAL, 500);
    if (ageMs < 300_000) return Math.min(DEFAULT_MAX_INTERVAL, 1500);
    return Math.min(DEFAULT_MAX_INTERVAL, 3000);
  }

  _tick() {
    if (this.pending.size === 0) return;
    if (this.orch.isPaused) return;

    const now = Date.now();
    const ready = [];
    for (const entry of this.pending.values()) {
      if (entry.nextFireAt <= now) ready.push(entry);
    }
    if (ready.length === 0) return;

    ready.sort((a, b) => a.priority - b.priority);

    const maxAgeMs = (this.orch._getMaxAgeMinutes() || 5) * 60000;

    for (const entry of ready) {
      const mint = entry.mint;
      const token = this.orch.tokenData.get(mint);

      if (!token || this.orch.passedTokens.has(mint)) {
        this.pending.delete(mint);
        this.stats.dropped++;
        continue;
      }

      const ageMs = Date.now() - token.timestamp;
      if (ageMs >= maxAgeMs) {
        this.pending.delete(mint);
        this.stats.dropped++;
        continue;
      }

      if (this.orch.processingTokens.has(mint)) {
        entry.nextFireAt = Date.now() + this._dynamicInterval(ageMs);
        this.stats.rescheduled++;
        continue;
      }

      this.pending.delete(mint);
      this.orch._rescanAttempts.set(
        mint,
        (this.orch._rescanAttempts.get(mint) || 0) + 1
      );
      this.orch.processingTokens.add(mint);
      if (!this.orch._analysisQueue) this.orch._analysisQueue = [];
      if (!this.orch._analysisQueue.includes(mint)) {
        this.orch._analysisQueue.push(mint);
      }
      this.stats.fired++;
      logger.debug(`🔁 [RescanScheduler] fire ${token.symbol || shortenAddress(mint)} age=${(ageMs/1000).toFixed(1)}s reason="${entry.reason}"`);
    }

    this.orch._processAnalysisQueue();
  }

  getStats() {
    return { ...this.stats, pendingSize: this.pending.size };
  }
}

module.exports = RescanScheduler;
