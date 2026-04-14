const logger = require('../utils/logger');
const { buildDefaultRules } = require('./rules');

/**
 * Rule Engine - Evaluates user-defined conditions to decide whether to buy a token
 *
 * Rules can be added/removed dynamically. Each rule is a function that receives
 * the full analysis context and returns { passed: boolean, reason: string }
 */
class RuleEngine {
  constructor() {
    this.rules = new Map();
    this.defaultRules = new Map();
    this.activeProfile = 'custom';
    this._registerDefaultRules();
  }

  /**
   * Register default built-in rules
   */
  _registerDefaultRules() {
    for (const rule of buildDefaultRules()) {
      const { id, ...rest } = rule;
      this.addRule(id, rest);
    }
    this.defaultRules = new Map(
      [...this.rules.entries()].map(([id, rule]) => [id, { ...rule }])
    );
  }

  /**
   * Add a custom rule
   */
  addRule(id, rule) {
    this.rules.set(id, { id, ...rule });
    logger.debug(`Rule added: ${id} (${rule.type})`);
  }

  /**
   * Remove a rule
   */
  removeRule(id) {
    this.rules.delete(id);
    logger.debug(`Rule removed: ${id}`);
  }

  /**
   * Enable/disable a rule
   */
  toggleRule(id, enabled) {
    const rule = this.rules.get(id);
    if (rule) {
      rule.enabled = enabled;
      logger.debug(`Rule ${id}: ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  /**
   * Bulk load rule states from database
   */
  loadStates(states) {
    if (!states) return;
    for (const [id, enabled] of Object.entries(states)) {
      this.toggleRule(id, enabled);
    }
  }

  /**
   * Update rule parameters
   */
  updateRule(id, params) {
    const rule = this.rules.get(id);
    if (rule) {
      Object.assign(rule, params);
      logger.debug(`Rule ${id} updated`);
    }
  }

  resetToDefaults() {
    this.rules = new Map(
      [...this.defaultRules.entries()].map(([id, rule]) => [id, { ...rule }])
    );
    logger.debug('Rule engine reset to default definitions');
  }

  setActiveProfile(profileId) {
    this.activeProfile = profileId || 'custom';
  }

  getActiveProfile() {
    return this.activeProfile || 'custom';
  }

  /**
   * Evaluate all enabled rules against the context
   * Returns: { shouldBuy, results, blockReasons, alertReasons }
   */
  evaluate(context) {
    const results = [];
    const blockReasons = [];
    const alertReasons = [];
    const infoMessages = [];
    let hasRetryableFailure = false;
    let hasHardFailure = false;

    for (const [id, rule] of this.rules) {
      if (!rule.enabled) continue;

      try {
        const result = rule.evaluate({ ...context, rule });
        const entry = {
          ruleId: id,
          ruleName: rule.name,
          ruleType: rule.type,
          ...result,
        };
        results.push(entry);

        if (!result.passed) {
          if (rule.type === 'BLOCK') blockReasons.push(entry);
          if (rule.type === 'ALERT') alertReasons.push(entry);
          if (rule.type === 'REQUIRE') blockReasons.push(entry);

          if (result.retryable || rule.retryable) {
            hasRetryableFailure = true;
          } else if (rule.type === 'REQUIRE' || rule.type === 'BLOCK') {
            hasHardFailure = true;
          }
        }

        if (rule.type === 'INFO') infoMessages.push(entry);
      } catch (err) {
        logger.error(`Rule ${id} evaluation failed: ${err.message}`);
        results.push({
          ruleId: id,
          ruleName: rule.name,
          ruleType: rule.type,
          passed: false,
          reason: `Error: ${err.message}`,
        });
        hasHardFailure = true;
      }
    }

    const shouldBuy = blockReasons.length === 0;
    const onlyRetryableFailed = !shouldBuy && hasRetryableFailure && !hasHardFailure;

    return {
      shouldBuy,
      onlyRetryableFailed,
      results,
      blockReasons,
      alertReasons,
      infoMessages,
      summary: shouldBuy
        ? `✅ ĐẠT — Thoả mãn tất cả điều kiện${alertReasons.length > 0 ? ` (${alertReasons.length} cảnh báo)` : ''}`
        : onlyRetryableFailed
          ? `⏳ CHỜ — Chỉ chưa đạt MCap, đang chờ tăng...`
          : `❌ KHÔNG ĐẠT — ${blockReasons.length} điều kiện bắt buộc không thoả`,
    };
  }

  /**
   * Get all rules and their current status
   */
  getRules() {
    return [...this.rules.values()].map((r) => {
      const { evaluate, ...rest } = r;
      return rest;
    });
  }
}

module.exports = new RuleEngine();
