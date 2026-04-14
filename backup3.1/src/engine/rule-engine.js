const settings = require('../config/settings');
const logger = require('../utils/logger');

/**
 * Rule Engine - Evaluates user-defined conditions to decide whether to buy a token
 *
 * Rules can be added/removed dynamically. Each rule is a function that receives
 * the full analysis context and returns { passed: boolean, reason: string }
 */
class RuleEngine {
  constructor() {
    this.rules = new Map();
    this._registerDefaultRules();
  }

  /**
   * Register default built-in rules
   */
  _registerDefaultRules() {
    // Rule 1: White wallet detection (ví trắng)
    // Ví mua có nhận tiền từ deployer và chưa từng trade trước đó
    this.addRule('white_wallet_from_deployer', {
      name: 'White Wallet From Deployer',
      description: 'Phát hiện ví trắng nhận tiền từ deployer (insider signal)',
      enabled: true,
      type: 'ALERT', // ALERT = cảnh báo, BLOCK = chặn mua, REQUIRE = bắt buộc phải đúng
      evaluate: (ctx) => {
        const { earlyBuyers, tokenData } = ctx;
        const deployer = tokenData.deployer;

        const whiteWalletsFromDev = earlyBuyers.filter(buyer =>
          buyer.isWhiteWallet && buyer.fundingWallets.includes(deployer)
        );

        if (whiteWalletsFromDev.length > 0) {
          let detail = `${whiteWalletsFromDev.length} VÍ TRẮNG nhận tiền từ deployer`;
          for (const w of whiteWalletsFromDev) {
            detail += `\n  → ${w.address.slice(0, 6)}...${w.address.slice(-4)} [VÍ TRẮNG] | ${w.txCount} txs | ${w.walletAgeDays} ngày`;
          }
          return { passed: false, reason: detail };
        }
        return { passed: true, reason: 'Không có VÍ TRẮNG từ deployer' };
      },
    });

    // Rule 2: White wallet from CEX (legitimate signal)
    // Ví trắng nhận tiền từ sàn CEX
    this.addRule('white_wallet_from_cex', {
      name: 'White Wallet From CEX',
      description: 'Ví trắng nhận tiền từ sàn CEX (organic buyer signal)',
      enabled: true,
      type: 'INFO',
      evaluate: (ctx) => {
        const { earlyBuyers } = ctx;
        const cexFunded = earlyBuyers.filter(buyer =>
          buyer.isWhiteWallet && buyer.sourceOfFunds?.hasCEXFunding
        );

        return {
          passed: true,
          reason: `${cexFunded.length} early buyer(s) funded from CEX`,
          data: { cexFundedCount: cexFunded.length },
        };
      },
    });

    // Rule 3: Same buy amount detection (cabal signal)
    // ALERT type: phát hiện coordinated buying là tín hiệu cảnh báo, không phải điều kiện bắt buộc
    // passed=false khi phát hiện cabal → hiện cảnh báo nhưng không chặn mua
    this.addRule('same_buy_amount', {
      name: 'Same Buy Amount Detection',
      description: 'Phát hiện các ví mua cùng lượng SOL giống nhau (cabal signal)',
      enabled: true,
      type: 'ALERT',
      tolerancePercent: 10,
      evaluate: (ctx) => {
        const { earlyBuyerTrades, clusterAnalysis } = ctx;
        if (earlyBuyerTrades.length < 2) return { passed: true, reason: 'Chưa đủ trades để so sánh' };

        const amounts = earlyBuyerTrades.map(t => t.solAmount);
        const tolerance = (ctx.rule?.tolerancePercent || 10) / 100;

        const groups = [];
        for (let i = 0; i < amounts.length; i++) {
          const amount = amounts[i];
          let found = false;
          for (const group of groups) {
            if (Math.abs(group.avg - amount) / Math.max(group.avg, 0.001) <= tolerance) {
              group.count++;
              group.avg = (group.avg * (group.count - 1) + amount) / group.count;
              group.amounts.push(amount);
              group.wallets.push(earlyBuyerTrades[i].trader);
              found = true;
              break;
            }
          }
          if (!found) {
            groups.push({ avg: amount, count: 1, amounts: [amount], wallets: [earlyBuyerTrades[i].trader] });
          }
        }

        const largestGroup = groups.reduce((max, g) => g.count > max.count ? g : max, { count: 0 });
        const hasMatchingAmounts = largestGroup.count >= 3;

        if (hasMatchingAmounts) {
          const walletsInCluster = largestGroup.wallets.filter(w =>
            clusterAnalysis?.wallets?.some(cw => cw.address === w)
          ).length;

          let detail = `⚠️ Tín hiệu Cabal: ${largestGroup.count} ví mua cùng lượng ~${largestGroup.avg.toFixed(4)} SOL`;
          if (walletsInCluster > 0) detail += ` (${walletsInCluster} ví từ cùng nguồn tiền)`;

          // Phát hiện cabal → fail (cảnh báo), nhưng ALERT type nên không chặn mua
          return {
            passed: false,
            reason: detail,
          };
        }
        return { passed: true, reason: 'Không phát hiện nhóm ví mua cùng số tiền' };
      },
    });

    // Rule 4: Global fee threshold (PumpFun)
    this.addRule('global_fee_threshold', {
      name: 'Global Fee Threshold',
      description: 'Kiểm tra global fee đạt ngưỡng > 0.3 SOL',
      enabled: true,
      type: 'REQUIRE',
      minGlobalFee: 0.3,
      evaluate: (ctx) => {
        const { tokenData } = ctx;
        const threshold = ctx.rule?.minGlobalFee || settings.rules.minGlobalFee || 0.3;
        
        // If globalFee is missing (like in a Manual Refresh from DexScreener),
        // we can estimate it from volume (Volume is 100x Global Fee on PumpFun)
        const currentFee = tokenData.globalFee || (tokenData.volume ? tokenData.volume / 100 : 0);

        return {
          passed: currentFee >= threshold,
          reason: currentFee >= threshold
            ? `Global fee ${currentFee.toFixed(4)} SOL >= ${threshold}`
            : `Global fee ${currentFee.toFixed(4)} SOL < ${threshold}`,
        };
      },
    });

    // Rule 5: Cluster detection (multiple wallets from same source)
    this.addRule('cluster_detection', {
      name: 'Cluster Detection',
      description: 'Phát hiện nhóm ví liên kết (Tín hiệu Winner x5+)',
      enabled: true,
      type: 'REQUIRE',
      minSharedFunders: settings.rules.minSharedFunders,
      evaluate: (ctx) => {
        const { clusterAnalysis } = ctx;
        if (!clusterAnalysis) return { passed: false, reason: 'Không có dữ liệu cluster' };

        if (!clusterAnalysis.isLikelyCluster) {
          return { passed: false, reason: 'Không phát hiện nhóm ví cùng nguồn (Cần tín hiệu cabal backing)' };
        }

        const minFunders = ctx.rule?.minSharedFunders || settings.rules.minSharedFunders || 3;
        const actualFunders = clusterAnalysis.sharedFunders.length;
        const isStrong = actualFunders >= minFunders;

        // Build detailed funder info
        let detail = `Insider signal: ${actualFunders} ví mẹ chung (Chia tiền)`;
        for (const f of clusterAnalysis.sharedFunders.slice(0, 3)) {
          detail += `\n  → ${f.address.slice(0, 6)}...${f.address.slice(-4)} | ${f.sharedBy} ví con`;
        }

        return { 
          passed: true, 
          reason: isStrong ? `✅ Tín hiệu Cabal mạnh: ${detail}` : `⚠️ Tín hiệu Cabal yếu: ${detail} (Winner thường có ≥ 3 ví mẹ)` 
        };
      },
    });

    // Rule 9: Top 10 Holder Check
    this.addRule('top10_holder_limit', {
      name: 'Top 10 Holder Limit',
      description: 'Top 10 holder phải < 30% total supply (trừ pool khỏi DS holder)',
      enabled: true,
      type: 'REQUIRE',
      maxPercent: settings.rules.maxPercentTop10,
      evaluate: (ctx) => {
        const { holderStats } = ctx;
        if (!holderStats) return { passed: false, reason: '⚠️ Không có dữ liệu holder để đánh giá Top 10' };

        // Fail-safe: if holder data is flagged invalid, don't use for decision
        if (holderStats.dataInvalid) {
          return { passed: false, reason: '⚠️ Dữ liệu holder không hợp lệ hoặc không nhất quán' };
        }

        const max = ctx.rule?.maxPercent || settings.rules.maxPercentTop10 || 30;
        const actual = holderStats.top10Percent; // % of total supply, pool excluded from holder list
        const passed = actual < max;
        const ownersActual = holderStats.top10OwnersPercent;

        return {
          passed,
          reason: passed
            ? `Top 10 nắm ${actual.toFixed(1)}% supply${holderStats.top10CirculatingPercent ? ` (Circulating: ${holderStats.top10CirculatingPercent.toFixed(1)}%)` : ''} (< ${max}%)${holderStats.preliminary ? ' | preliminary' : ''}${typeof ownersActual === 'number' ? ` | Owners: ${ownersActual.toFixed(1)}%` : ''}`
            : `Top 10 nắm quá cao: ${actual.toFixed(1)}% supply${holderStats.top10CirculatingPercent ? ` (Circulating: ${holderStats.top10CirculatingPercent.toFixed(1)}%)` : ''} (> ${max}%)${holderStats.preliminary ? ' | preliminary' : ''}${typeof ownersActual === 'number' ? ` | Owners: ${ownersActual.toFixed(1)}%` : ''}`,
        };
      },
    });

    // Rule 10: Dev Hold Check
    this.addRule('dev_hold_limit', {
      name: 'Dev Hold Limit',
      description: 'Dev hold phải < 20% total supply',
      enabled: true,
      type: 'REQUIRE',
      maxPercent: 20,
      evaluate: (ctx) => {
        const { holderStats } = ctx;
        if (!holderStats) return { passed: false, reason: '⚠️ Không có dữ liệu holder để đánh giá Dev Hold' };
        if (holderStats.dataInvalid) {
          return { passed: false, reason: '⚠️ Dữ liệu holder không hợp lệ' };
        }

        const max = ctx.rule?.maxPercent || settings.rules.maxPercentDev || 20;
        const actual = holderStats.devHoldPercent;
        const passed = actual < max;
        return {
          passed,
          reason: passed
            ? `Dev nắm ${actual.toFixed(1)}% supply (< ${max}%)`
            : `Dev nắm quá cao: ${actual.toFixed(1)}% supply (> ${max}%)`,
        };
      },
    });

    // Rule 11: Bundle Check
    this.addRule('bundle_limit', {
      name: 'Bundle Limit',
      description: 'Bundle phải < 20% total supply',
      enabled: true,
      type: 'REQUIRE',
      maxPercent: 20,
      evaluate: (ctx) => {
        const { holderStats } = ctx;
        if (!holderStats) return { passed: false, reason: '⚠️ Không có dữ liệu holder để đánh giá Bundle' };
        if (holderStats.dataInvalid) {
          return { passed: false, reason: '⚠️ Dữ liệu holder không hợp lệ' };
        }

        const max = ctx.rule?.maxPercent || settings.rules.maxPercentBundle || 20;
        const actual = holderStats.bundleHoldPercent;
        const passed = actual < max;
        return {
          passed,
          reason: passed
            ? `Bundle nắm ${actual.toFixed(1)}% supply (< ${max}%)`
            : `Bundle nắm quá cao: ${actual.toFixed(1)}% supply (> ${max}%)`,
        };
      },
    });

    // Rule 12: Volume Check
    this.addRule('volume_threshold', {
      name: 'Volume Threshold',
      description: 'Volume phải > 30 SOL',
      enabled: true,
      type: 'REQUIRE',
      minVol: settings.rules.minVol,
      evaluate: (ctx) => {
        const { tokenData } = ctx;
        // Priority: use tokenData.volume (from DexScreener), fallback to globalFee * 100 (from PumpFun)
        const actual = tokenData.volume || (tokenData.globalFee || 0) * 100;
        const min = ctx.rule?.minVol || settings.rules.minVol || 30;
        const passed = actual >= min;
        
        return {
          passed,
          reason: passed 
            ? `Vol hiện tại ${actual.toFixed(1)} SOL (Đạt mức > ${min} SOL)`
            : `Vol quá thấp: ${actual.toFixed(1)} SOL (Chưa đạt ${min} SOL)`,
        };
      },
    });

    // Rule 13: Listing Age Check
    this.addRule('listing_age_limit', {
      name: 'Listing Age Check',
      description: 'Token list < 5 phút',
      enabled: true,
      type: 'REQUIRE',
      maxMinutes: settings.rules.maxMinutes,
      evaluate: (ctx) => {
        const { tokenData } = ctx;
        const ageMinutes = (Date.now() - tokenData.timestamp) / 60000;
        const max = ctx.rule?.maxMinutes || 5;
        
        return {
          passed: ageMinutes < max,
          reason: `Age: ${ageMinutes.toFixed(1)}m (max: ${max}m)`,
        };
      },
    });

    // Rule 14: Market Cap Check
    // Token phải đạt mức vốn hoá tối thiểu (SOL). Nếu chưa đạt → re-scan liên tục đến khi quá age limit.
    this.addRule('market_cap_check', {
      name: 'Market Cap Check',
      description: 'Vốn hoá thị trường phải đạt mức tối thiểu (SOL)',
      enabled: true,
      type: 'REQUIRE',
      minMarketCapSol: settings.rules.minMarketCapSol,
      retryable: true, // Flag đặc biệt: nếu fail rule này → re-scan thay vì bỏ qua
      evaluate: (ctx) => {
        const { tokenData } = ctx;
        const min = ctx.rule?.minMarketCapSol || settings.rules.minMarketCapSol || 10;
        const actual = tokenData.marketCapSol || 0;
        const passed = actual >= min;

        return {
          passed,
          retryable: !passed, // Chưa đạt MCap → có thể đạt sau, cần re-scan
          reason: passed
            ? `MCap ${actual.toFixed(2)} SOL >= ${min} SOL ✓`
            : `MCap ${actual.toFixed(2)} SOL < ${min} SOL (chờ tăng...)`,
        };
      },
    });

    // Rule 6: Dev risk score
    this.addRule('dev_risk_check', {
      name: 'Dev Risk Check',
      description: 'Kiểm tra độ rủi ro của deployer dựa trên lịch sử',
      enabled: true,
      type: 'ALERT',
      maxRiskScore: settings.rules.maxRiskScore,
      evaluate: (ctx) => {
        const { devAnalysis } = ctx;
        if (!devAnalysis) return { passed: true, reason: 'No dev analysis data' };

        const maxScore = ctx.rule?.maxRiskScore || settings.rules.maxRiskScore || 60;
        return {
          passed: devAnalysis.riskScore < maxScore,
          reason: devAnalysis.riskScore >= maxScore
            ? `Dev risk score ${devAnalysis.riskScore}/100 exceeds max ${maxScore} (${devAnalysis.riskLevel})`
            : `Dev risk score: ${devAnalysis.riskScore}/100 (${devAnalysis.riskLevel})`,
        };
      },
    });

    // Rule 7: Token score check
    this.addRule('token_score_check', {
      name: 'Token Score Check',
      description: 'Kiểm tra điểm token metadata/quality',
      enabled: false,
      type: 'REQUIRE',
      minScore: settings.rules.minScore,
      evaluate: (ctx) => {
        const { tokenScore } = ctx;
        if (!tokenScore) return { passed: true, reason: 'No token score data' };

        const minScore = ctx.rule?.minScore || settings.rules.minScore || 40;
        return {
          passed: tokenScore.totalScore >= minScore,
          reason: `Token score: ${tokenScore.totalScore}/100 (${tokenScore.verdict})`,
        };
      },
    });

    // Rule 8: Bonding curve progress
    this.addRule('bonding_curve_progress', {
      name: 'Bonding Curve Progress',
      description: 'Kiểm tra % tiến trình bonding curve',
      enabled: false,
      type: 'INFO',
      maxProgressPercent: settings.rules.maxProgressPercent,
      evaluate: (ctx) => {
        const { bondingCurveProgress } = ctx;
        if (bondingCurveProgress === undefined) return { passed: true, reason: 'No bonding curve data' };

        const maxProgress = ctx.rule?.maxProgressPercent || settings.rules.maxProgressPercent || 80;
        return {
          passed: bondingCurveProgress < maxProgress,
          reason: `Bonding curve: ${bondingCurveProgress.toFixed(1)}% (max: ${maxProgress}%)`,
        };
      },
    });

    // Rule 15: Fresh Wallet Detection (Rug Pull Signal)
    // Phát hiện ví "mới toanh" — 0 SOL cho đến khoảng 2 giờ trước khi mua token
    // Đây là tín hiệu rug pull mạnh: nhiều ví mới được nạp tiền đồng loạt để mua
    this.addRule('fresh_wallet_check', {
      name: 'Fresh Wallet Detection',
      description: 'Cảnh báo khi > 4 ví mua sớm là ví mới (0 SOL cho đến ~2h trước)',
      enabled: true,
      type: 'ALERT',
      maxFreshCount: settings.rules.maxFreshCount,
      evaluate: (ctx) => {
        const { earlyBuyers } = ctx;
        if (!earlyBuyers || earlyBuyers.length < 2) {
          return { passed: true, reason: 'Chưa đủ buyer để đánh giá' };
        }

        const nowSec = Date.now() / 1000;
        const twoHoursAgo = nowSec - (2 * 3600); // 2 giờ trước

        // Ví "fresh" = tuổi < 1 ngày VÀ giao dịch đầu tiên trong vòng 2 giờ gần đây
        // → nghĩa là ví không có SOL cho đến ~2h trước
        const freshWallets = earlyBuyers.filter(buyer => {
          const isYoung = buyer.walletAgeDays < 1;
          // firstTxTimestamp = blockTime (giây) của giao dịch cũ nhất tìm thấy
          const firstFundedRecently = buyer.firstTxTimestamp && buyer.firstTxTimestamp > twoHoursAgo;
          return isYoung && firstFundedRecently;
        });

        const maxCount = ctx.rule?.maxFreshCount || settings.rules.maxFreshCount || 4;

        if (freshWallets.length > maxCount) {
          let detail = `⚠️ ${freshWallets.length}/${earlyBuyers.length} ví mua sớm là VÍ MỚI TOANH (> ${maxCount} ví)`;
          // Show details of the fresh wallets
          for (const w of freshWallets.slice(0, 5)) {
            const ageHours = w.firstTxTimestamp ? ((nowSec - w.firstTxTimestamp) / 3600).toFixed(1) : '?';
            detail += `\n  → ${w.address.slice(0, 6)}...${w.address.slice(-4)} | ${w.txCount} txs | ${ageHours}h tuổi | ${w.balance?.toFixed(2) || '?'} SOL`;
          }
          return { passed: false, reason: detail };
        }

        return {
          passed: true,
          reason: `${freshWallets.length}/${earlyBuyers.length} ví mới toanh (≤ ${maxCount} ví)`,
        };
      },
    });

    // Rule 8: First 7 Buyers Hold Limit
    this.addRule('first_7_buyers_hold_limit', {
      name: 'First 7 Buyers Hold Limit',
      description: 'Chặn nếu 7 lệnh mua đầu tiên chiếm > 25% tổng cung',
      enabled: true,
      type: 'BLOCK',
      maxPercent: settings.rules.maxPercentFirst7Buyers,
      evaluate: (ctx) => {
        const { earlyBuyerTrades, holderStats } = ctx;
        if (!earlyBuyerTrades || earlyBuyerTrades.length === 0) {
          return { passed: true, reason: 'Chưa có lệnh mua sớm' };
        }
        if (!holderStats || !holderStats.supply) {
          return { passed: false, reason: '⚠️ Thiếu dữ liệu tổng cung để tính toán %' };
        }

        const totalSupply = holderStats.supply;
        // Take first 7 buy orders (already sorted by time in earlyBuyerTrades)
        const first7 = earlyBuyerTrades.slice(0, 7);
        const totalTokens = first7.reduce((sum, t) => sum + (t.tokenAmount || 0), 0);
        const actualPercent = (totalTokens / totalSupply) * 100;
        const max = ctx.rule?.maxPercent || settings.rules.maxPercentFirst7Buyers || 25;

        const passed = actualPercent <= max;
        return {
          passed,
          reason: passed
            ? `7 lệnh đầu nắm ${actualPercent.toFixed(2)}% cung (<= ${max}%)`
            : `7 lệnh đầu nắm quá cao: ${actualPercent.toFixed(2)}% cung (> ${max}%)`,
          data: { first7Percent: actualPercent }
        };
      },
    });

    // Rule 14: Early Buyer Count Check
    this.addRule('early_buyer_count_check', {
      name: 'Early Buyer Count Check',
      description: 'Đảm bảo có đủ số lượng người mua tối thiểu để phân tích',
      enabled: true,
      type: 'BLOCK',
      minCount: settings.monitoring.minBuyersToPass,
      evaluate: (ctx) => {
        const { earlyBuyers } = ctx;
        const count = earlyBuyers.length;
        const min = ctx.rule?.minCount || settings.monitoring.minBuyersToPass || 5;

        const passed = count >= min;
        return {
          passed,
          reason: passed
            ? `Đã đạt tối thiểu ${min} ví mua sớm (${count}/${min})`
            : `Chưa đủ ${min} ví mua sớm (${count}/${min})`,
          data: { buyerCount: count, minRequired: min }
        };
      },
    });
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

          // Track retryable vs hard failures
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

    // onlyRetryableFailed = true khi CHỈ có retryable rules fail (như MCap), các rule khác đều pass
    // → orchestrator sẽ re-scan liên tục thay vì bỏ qua
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
    return [...this.rules.values()].map(r => {
      const { evaluate, ...rest } = r;
      return rest;
    });
  }
}

module.exports = new RuleEngine();
