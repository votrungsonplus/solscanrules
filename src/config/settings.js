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
    earlyBuyersToMonitor: parseInt(process.env.EARLY_BUYERS_TO_MONITOR || '10'),
    minBuyersToPass: parseInt(process.env.MIN_BUYERS_TO_PASS || '5'),
    globalFeeThreshold: parseFloat(process.env.GLOBAL_FEE_THRESHOLD || '0.5'),
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
  rules: {
    minMarketCapSol: parseFloat(process.env.RULE_MIN_MC_SOL || process.env.MIN_MARKET_CAP_SOL || '10'),
    maxMinutes: parseInt(process.env.RULE_MAX_AGE_MIN || '5'),
    maxPercentTop10: parseFloat(process.env.RULE_TOP10_MAX_PCT || '30'),
    minPercentTop10: parseFloat(process.env.RULE_TOP10_MIN_PCT || '15'),
    maxPercentDev: parseFloat(process.env.RULE_DEV_HOLD_MAX_PCT || '20'),
    maxPercentBundle: parseFloat(process.env.RULE_BUNDLE_MAX_PCT || '20'),
    minVol: parseFloat(process.env.RULE_MIN_VOL_SOL || '30'),
    minGlobalFee: parseFloat(process.env.RULE_MIN_GLOBAL_FEE || process.env.GLOBAL_FEE_THRESHOLD || '0.3'),
    minSharedFunders: parseInt(process.env.RULE_MIN_FUNDERS || '3'),
    maxRiskScore: parseInt(process.env.RULE_MAX_RISK || '50'),
    minScore: parseInt(process.env.RULE_MIN_SCORE || '40'),
    maxProgressPercent: parseFloat(process.env.RULE_MAX_PROGRESS || '80'),
    maxFreshCount: parseInt(process.env.RULE_MAX_FRESH || '2'),
    maxPercentFirst7Buyers: parseFloat(process.env.RULE_MAX_PCT_7_BUYERS || '25'),
    tolerancePercent: parseFloat(process.env.RULE_TOLERANCE_PCT || '10'),
  },
};

module.exports = settings;
