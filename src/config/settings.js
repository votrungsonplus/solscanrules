require('dotenv').config();

const settings = {
  // Solana RPC
  rpcUrls: (process.env.SOLANA_RPC_URLS || 'https://api.mainnet-beta.solana.com').split(',').map(u => u.trim()),
  wsUrl: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
  heliusExecutionRpcUrl: process.env.HELIUS_EXECUTION_RPC_URL || '',
  heliusSenderUrl: process.env.HELIUS_SENDER_URL || '',

  // Wallet
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || '',

  // Jito
  jito: {
    enabled: process.env.JITO_ENABLED === 'true',
    tipAmount: parseFloat(process.env.JITO_TIP_AMOUNT || '0.001'),
    blockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf',
    tipAccounts: (process.env.JITO_TIP_ACCOUNTS || '').split(',').map(a => a.trim()).filter(a => a),
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatIds: (process.env.TELEGRAM_CHAT_ID || '').split(',').map(id => id.trim()).filter(id => id),
  },

  // PumpFun
  pumpfun: {
    programId: process.env.PUMPFUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    wsUrl: process.env.PUMPFUN_WS_URL || 'wss://pumpportal.fun/api/data',
    // Redundancy thật: shadow URL khác nguồn (vd Helius enhanced WS) tránh single point of failure
    wsUrlShadow: process.env.PUMPFUN_WS_URL_SHADOW || '',
    // Bonding curve migration threshold (SOL) — PumpFun đôi khi tinh chỉnh; cho phép env override
    migrateThresholdSol: parseFloat(process.env.PUMPFUN_MIGRATE_SOL_THRESHOLD || '85'),
  },

  // Trading
  trading: {
    autoBuyEnabled: process.env.AUTO_BUY_ENABLED === 'true',
    autoSellEnabled: process.env.AUTO_SELL_ENABLED !== 'false', // Default ON
    buyAmountSol: parseFloat(process.env.BUY_AMOUNT_SOL || '0.1'),
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '5'),
    dailyLossLimitSol: parseFloat(process.env.DAILY_LOSS_LIMIT_SOL || '2.0'),
    buySlippage: parseInt(process.env.BUY_SLIPPAGE || '15'),
    sellSlippage: parseInt(process.env.SELL_SLIPPAGE || '20'),
  },

  // Take Profit / Stop Loss
  risk: {
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT || '100'),
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT || '50'),
  },

  // Monitoring
  monitoring: {
    // Tăng từ 10 → 20 để bắt được bundle có > 10 ví. Vẫn cap ở 20 để giới hạn RPC.
    earlyBuyersToMonitor: parseInt(process.env.EARLY_BUYERS_TO_MONITOR || '20'),
    minBuyersToPass: parseInt(process.env.MIN_BUYERS_TO_PASS || '5'),
    // Dùng chung nguồn với rules.minGlobalFee — tránh phân mảnh
    globalFeeThreshold: parseFloat(process.env.RULE_MIN_GLOBAL_FEE || process.env.GLOBAL_FEE_THRESHOLD || '0.3'),
    monitoringDuration: parseInt(process.env.MONITORING_DURATION || '300'), // 5 minutes to wait for 5 buyers
    showAllEarlyBuyers: process.env.SHOW_ALL_EARLY_BUYERS === 'true',
  },

  // Performance & Execution
  performance: {
    tier: process.env.PERFORMANCE_TIER || 'PRO', // STANDARD, PRO, WARP
    multiplexRPC: process.env.MULTIPLEX_RPC !== 'false',
    maxConcurrentAnalysis: parseInt(process.env.MAX_CONCURRENT_ANALYSIS || '10'),
    useOptimisticSend: process.env.OPTIMISTIC_SEND !== 'false',
  },

  // Dynamic Fees
  fees: {
    priorityFeeMultiplier: parseFloat(process.env.PRIORITY_FEE_MULTIPLIER || '2.0'),
    minPriorityFee: parseFloat(process.env.MIN_PRIORITY_FEE || '0.0001'),
    maxPriorityFee: parseFloat(process.env.MAX_PRIORITY_FEE || '0.01'),
    jitoTipMultiplier: parseFloat(process.env.JITO_TIP_MULTIPLIER || '1.5'),
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Rules Engine Defaults (Synchronized with Dashboard)
  // Các default này đã được điều chỉnh dựa trên phân tích 2,205 pass token
  // (báo cáo: docs/bao-cao-rules/BAO-CAO-TOAN-DIEN.md)
  rules: {
    // Floor MCap nâng từ 80→100 (loại bỏ vùng 80-100 SOL có dud rate ~35%)
    minMarketCapSol: parseFloat(process.env.RULE_MIN_MC_SOL || process.env.MIN_MARKET_CAP_SOL || '100'),
    // Ceiling MCap mới: chặn pass khi đã quá đỉnh (>250 SOL = vào sau ATH)
    maxMarketCapSol: parseFloat(process.env.RULE_MAX_MC_SOL || '250'),
    maxMinutes: parseInt(process.env.RULE_MAX_AGE_MIN || '8'),
    // Top10 max siết 28→50 (sweet spot 15-50% cho tỉ lệ win/dud tốt nhất)
    maxPercentTop10: parseFloat(process.env.RULE_TOP10_MAX_PCT || '50'),
    minPercentTop10: parseFloat(process.env.RULE_TOP10_MIN_PCT || '15'),
    // Dev hold siết về 30 (data: <2% là đa số, >30% rất hiếm + risky)
    maxPercentDev: parseFloat(process.env.RULE_DEV_HOLD_MAX_PCT || '30'),
    // Bundle siết 20→10 (data: bundle 5-10% có dud thấp nhất, >10% rủi ro cao)
    maxPercentBundle: parseFloat(process.env.RULE_BUNDLE_MAX_PCT || '10'),
    minVol: parseFloat(process.env.RULE_MIN_VOL_SOL || '90'),
    minGlobalFee: parseFloat(process.env.RULE_MIN_GLOBAL_FEE || process.env.GLOBAL_FEE_THRESHOLD || '0.3'),
    minSharedFunders: parseInt(process.env.RULE_MIN_FUNDERS || '2'),
    maxRiskScore: parseInt(process.env.RULE_MAX_RISK || '50'),
    minScore: parseInt(process.env.RULE_MIN_SCORE || '40'),
    maxProgressPercent: parseFloat(process.env.RULE_MAX_PROGRESS || '80'),
    maxPercentFirst7Buyers: parseFloat(process.env.RULE_MAX_PCT_7_BUYERS || '25'),
    tolerancePercent: parseFloat(process.env.RULE_TOLERANCE_PCT || '10'),
    // Whale buy concentration: tổng SOL của early buyers (data: >20 SOL = 42% dud)
    whaleMaxTotalSol: parseFloat(process.env.RULE_WHALE_MAX_TOTAL_SOL || '15'),
    // New Wallet Accumulation rule
    accumulationCheckFirstX: parseInt(process.env.RULE_ACCUMULATION_CHECK_X || '5'),
    accumulationMaxPercent: parseFloat(process.env.RULE_ACCUMULATION_MAX_PCT || '25'),
    // New Wallet Total Hold Limit rule (final gate)
    newWalletTotalHoldMaxPercent: parseFloat(process.env.RULE_NEW_WALLET_TOTAL_HOLD_MAX || '15'),
  },

  // Anti-top-buy: trước khi pass alert/buy, đợi N ms để xem giá có dump không.
  // Giải quyết "46% pass tại đỉnh" — token pump rồi dump ngay sau pass.
  antiTopBuy: {
    enabled: process.env.ANTI_TOP_BUY_ENABLED !== 'false', // mặc định BẬT
    delayMs: parseInt(process.env.ANTI_TOP_BUY_DELAY_MS || '5000'),
    maxDriftPercent: parseFloat(process.env.ANTI_TOP_BUY_MAX_DRIFT_PCT || '8'), // skip nếu MC giảm > 8%
  },

  // DB cleanup: tự động xoá scans cũ để tránh phình DB (5GB+)
  dbCleanup: {
    enabled: process.env.DB_CLEANUP_ENABLED !== 'false',
    keepScansDays: parseInt(process.env.DB_KEEP_SCANS_DAYS || '7'),
    keepDetectedDays: parseInt(process.env.DB_KEEP_DETECTED_DAYS || '14'),
    runIntervalHours: parseInt(process.env.DB_CLEANUP_INTERVAL_HOURS || '24'),
  },

  // Holder stats cache TTL (ms) — cao tốt cho rescan, thấp tốt cho data tươi
  // Adaptive: TTL ngắn khi MC sát ngưỡng pass (tránh false positive)
  holderCache: {
    ttlMs: parseInt(process.env.HOLDER_CACHE_TTL_MS || '8000'),
    // TTL ngắn dùng khi |MC - threshold| / threshold <= nearThresholdPct
    nearThresholdTtlMs: parseInt(process.env.HOLDER_CACHE_NEAR_TTL_MS || '2000'),
    nearThresholdPct: parseFloat(process.env.HOLDER_CACHE_NEAR_PCT || '0.10'),
  },

  // Fast alert mode — emit signal preview tại buyer #1 nếu critical rules pass
  // (mint_renounce, transfer_fee, dev_risk, launch_mcap_ceiling). Chỉ dashboard,
  // không telegram, không auto-buy. Giúp giảm 5-15s alert latency.
  fastAlert: {
    enabled: process.env.FAST_ALERT_ENABLED !== 'false',
    rules: (process.env.FAST_ALERT_RULES || 'mint_renounce_check,transfer_fee_check,dev_risk_check,launch_mcap_ceiling,market_cap_check')
      .split(',').map(s => s.trim()).filter(Boolean),
  },

  // Direct logs subscription tới PumpFun program — pre-cache (signature, slot)
  // để bundle detection không phải gọi lại getParsedTransaction chỉ để lấy slot.
  directLogs: {
    enabled: process.env.DIRECT_LOGS_ENABLED !== 'false',
    commitment: process.env.DIRECT_LOGS_COMMITMENT || 'processed', // processed = ~400ms
    cacheTtlMs: parseInt(process.env.DIRECT_LOGS_CACHE_TTL_MS || (5 * 60 * 1000), 10),
  },
};

module.exports = settings;
