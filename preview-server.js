// Lightweight preview server for dashboard UI verification only
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'src/web/public')));

// Mock Socket.IO events so dashboard renders correctly
io.on('connection', (socket) => {
  // Send mock data for preview
  socket.emit('solPriceUpdate', 148.52);
  socket.emit('botStatus', { autoBuyEnabled: false, buyAmountSol: 0.1, takeProfitPercent: 100, stopLossPercent: 50, maxPositions: 5, earlyBuyersToMonitor: 5 });
  socket.emit('dailyStats', { tokensScanned: 142, tokensBought: 3, tokensSold: 1, totalPnlSol: 0.45, wins: 1, losses: 0, winRate: 100 });
  socket.emit('rulesList', [
    { id: 'white_wallet_from_deployer', name: 'White Wallet From Deployer', type: 'ALERT', enabled: true },
    { id: 'same_buy_amount', name: 'Same Buy Amount Detection', type: 'REQUIRE', enabled: true },
    { id: 'global_fee_threshold', name: 'Global Fee Threshold', type: 'REQUIRE', enabled: true },
    { id: 'top10_holder_limit', name: 'Top 10 Holder Limit', type: 'REQUIRE', enabled: true },
    { id: 'dev_hold_limit', name: 'Dev Hold Limit', type: 'REQUIRE', enabled: true },
    { id: 'volume_threshold', name: 'Volume Threshold', type: 'REQUIRE', enabled: true },
    { id: 'listing_age_limit', name: 'Listing Age Check', type: 'REQUIRE', enabled: true },
    { id: 'dev_risk_check', name: 'Dev Risk Check', type: 'ALERT', enabled: true },
    { id: 'bonding_curve_progress', name: 'Bonding Curve Progress', type: 'INFO', enabled: false },
  ]);

  socket.emit('initialFeed', [
    { mint: 'AbC123xYz456AbC123xYz456AbC123xYz456AbC123xy', symbol: 'PEPE2', name: 'Pepe Returns', timestamp: Date.now() - 120000, status: 'ELIGIBLE' },
    { mint: 'DeF789uVw012DeF789uVw012DeF789uVw012DeF789uv', symbol: 'DOGE3', name: 'DogeX', timestamp: Date.now() - 60000, status: 'BLOCKED' },
    { mint: 'GhI345rSt678GhI345rSt678GhI345rSt678GhI345rs', symbol: 'MOON', name: 'MoonShot', timestamp: Date.now() - 30000, status: null },
    { mint: 'JkL901mNp234JkL901mNp234JkL901mNp234JkL901mn', symbol: 'WIF2', name: 'DogWifHat2', timestamp: Date.now() - 15000, status: 'ELIGIBLE' },
  ]);

  socket.emit('initialScans', []);

  socket.emit('passedTokensUpdate', [
    { mint: 'AbC123xYz456AbC123xYz456AbC123xYz456AbC123xy', symbol: 'PEPE2', launch_mcap_usd: 8500, highest_mcap_usd: 52000, timestamp: Date.now() - 3600000 },
    { mint: 'JkL901mNp234JkL901mNp234JkL901mNp234JkL901mn', symbol: 'WIF2', launch_mcap_usd: 12000, highest_mcap_usd: 89000, timestamp: Date.now() - 7200000 },
  ]);

  socket.emit('tradeHistory', [
    { action: 'BUY', mint: 'AbC123xYz456AbC123xYz456AbC123xYz456AbC123xy', token_symbol: 'PEPE2', sol_amount: 0.1, timestamp: Date.now() - 3600000 },
    { action: 'SELL', mint: 'AbC123xYz456AbC123xYz456AbC123xYz456AbC123xy', token_symbol: 'PEPE2', sol_amount: 0.25, pnl_percent: 150, timestamp: Date.now() - 1800000 },
  ]);

  // Mock analysis when user clicks a token
  socket.on('getAnalysis', (mint) => {
    socket.emit('analysisResult', {
      tokenData: {
        mint,
        symbol: 'PEPE2',
        name: 'Pepe Returns',
        deployer: 'Dev123456789abcDev123456789abcDev123456789ab',
        marketCapSol: 42.5,
        marketCapUsd: 6308,
        vSolInBondingCurve: 18.2,
        bondingCurveProgress: 21.4,
        globalFee: 0.85,
        timestamp: Date.now() - 120000,
      },
      ruleResult: {
        shouldBuy: true,
        summary: 'PASS - Thoa man tat ca dieu kien (1 canh bao)',
        results: [
          { ruleId: 'same_buy_amount', ruleName: 'Same Buy Amount Detection', ruleType: 'REQUIRE', passed: true, reason: 'Tin hieu Cabal: 3 vi mua cung luong ~0.1500 SOL' },
          { ruleId: 'global_fee_threshold', ruleName: 'Global Fee Threshold', ruleType: 'REQUIRE', passed: true, reason: 'Global fee 0.8500 SOL >= 0.3' },
          { ruleId: 'top10_holder_limit', ruleName: 'Top 10 Holder Limit', ruleType: 'REQUIRE', passed: true, reason: 'Top 10 nam 18.5% (Thoa dieu kien < 30%)' },
          { ruleId: 'dev_hold_limit', ruleName: 'Dev Hold Limit', ruleType: 'REQUIRE', passed: true, reason: 'Dev nam 5.2% (Thoa dieu kien < 20%)' },
          { ruleId: 'volume_threshold', ruleName: 'Volume Threshold', ruleType: 'REQUIRE', passed: true, reason: 'Vol hien tai 85.0 SOL (Dat muc > 10 SOL)' },
          { ruleId: 'listing_age_limit', ruleName: 'Listing Age Check', ruleType: 'REQUIRE', passed: true, reason: 'Age: 2.0m (max: 5m)' },
          { ruleId: 'dev_risk_check', ruleName: 'Dev Risk Check', ruleType: 'ALERT', passed: false, reason: 'Dev risk score 45/100 (MEDIUM)' },
          { ruleId: 'white_wallet_from_deployer', ruleName: 'White Wallet From Deployer', ruleType: 'ALERT', passed: true, reason: 'Khong co VI TRANG tu deployer' },
        ]
      },
      devAnalysis: {
        address: 'Dev123456789abcDev123456789abcDev123456789ab',
        riskScore: 45,
        riskLevel: 'MEDIUM',
        balanceSol: 2.35,
        totalTxCount: 28,
        tokensDeployed: 4,
        walletAge: 32,
      },
      tokenScore: {
        totalScore: 72,
        verdict: 'STRONG',
        metadataScore: 45,
        bondingCurveScore: 15,
        uriScore: 12,
      },
      holderStats: {
        top10Percent: 18.5,
        devHoldPercent: 5.2,
        clusterHoldPercent: 8.1,
      },
      clusterAnalysis: {
        isLikelyCluster: true,
        riskLevel: 'MEDIUM',
        sharedFunders: [{ address: 'Funder1...abc', sharedBy: 3 }],
        whiteWalletCount: 2,
        walletCount: 5,
      },
      earlyBuyers: [
        { address: 'Buyer1aaaabbbbccccddddeeee1111222233334444', isWhiteWallet: false, balance: 1.5, walletAgeDays: 45, txCount: 120, sourceOfFunds: { hasCEXFunding: true }, fundingWallets: [] },
        { address: 'Buyer2aaaabbbbccccddddeeee5555666677778888', isWhiteWallet: true, balance: 0.3, walletAgeDays: 2, txCount: 3, sourceOfFunds: { hasCEXFunding: false }, fundingWallets: ['Funder1'] },
        { address: 'Buyer3aaaabbbbccccddddeeee9999000011112222', isWhiteWallet: true, balance: 0.25, walletAgeDays: 1, txCount: 2, sourceOfFunds: { hasCEXFunding: false }, fundingWallets: ['Funder1'] },
        { address: 'Buyer4aaaabbbbccccddddeeeeFFFFeeeeDDDDcccc', isWhiteWallet: false, balance: 5.2, walletAgeDays: 180, txCount: 450, sourceOfFunds: { hasCEXFunding: true }, fundingWallets: [] },
        { address: 'Buyer5aaaabbbbccccddddeeeeAAAABBBBCCCCDDDD', isWhiteWallet: false, balance: 0.8, walletAgeDays: 15, txCount: 22, sourceOfFunds: { hasCEXFunding: false }, fundingWallets: ['Funder1'] },
      ],
      globalFee: 0.85,
    });
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Preview server running at http://localhost:${port}`);
});
