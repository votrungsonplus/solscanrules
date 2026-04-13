const telegramBot = require('../src/telegram/telegram-bot');
const settings = require('../src/config/settings');
const logger = require('../src/utils/logger');

async function testAlert() {
  console.log('🚀 Đang khởi động test Telegram Alert...');
  console.log('Chat IDs:', settings.telegram.chatIds);

  // Khởi tạo bot
  telegramBot.init(async (cmd, params) => {
    console.log(`Command received in test: ${cmd}`);
    return null;
  });

  // Giả lập dữ liệu token
  const tokenData = {
    mint: '69TDsqsWne8QMgVYDD1R5FbawBa8Sx11Mzh1CzWdpump',
    name: 'Phanes Bot Test',
    symbol: 'TEST',
    timestamp: Date.now() - 300000, // 5 mins ago
    deployer: '71JxdDs78M6gVYDD1R5FbawBa8Sx11Mzh1CzWd4yB6',
    marketCapUsd: 6503,
    marketCapSol: 75.18,
    globalFee: 1.7246,
  };

  // Giả lập kết quả phân tích
  const analysisResult = {
    ruleResult: {
      passed: true,
      shouldBuy: false,
      summary: 'Dữ liệu test định dạng cho @Phanes_bot',
      results: [
        { passed: true, ruleName: 'White Wallet From Deployer', ruleType: 'INFO', reason: 'Không có VÍ TRẮNG từ deployer' },
        { passed: true, ruleName: 'Global Fee Threshold', ruleType: 'INFO', reason: 'Global fee 1.7246 SOL >= 0.3' }
      ]
    },
    devAnalysis: { riskScore: 10, riskLevel: 'Low' },
    clusterAnalysis: {
      sharedFunders: [
        { address: 'DdfC3N...x8bJ', sharedBy: 2 },
        { address: '4676TR...vJ5i', sharedBy: 2 }
      ]
    },
    tokenScore: { totalScore: 85, verdict: 'TỐT' },
    holderStats: {
      realHolderCount: 19,
      filteredFunctionalCount: 1,
      top10Percent: 23.9,
      top10OwnersPercent: 23.9,
      devHoldPercent: 0,
      bundleHoldPercent: 0,
      earlyBuyerHoldPercent: 0
    }
  };

  try {
    console.log('Đang gửi alert...');
    await telegramBot.sendNewTokenAlert(tokenData, analysisResult);
    
    console.log('Đang gửi buy notification...');
    const buyResult = {
      success: true,
      signature: 'kp6H2KA5YepKuxWbq5aBXmjM8q2bYogKyKYc2WCXZsvv1x2h9i6T4dWh6u3qnqKJxvyKe9MgBkdRDq2VMaFkDr5',
      solAmount: 0.1
    };
    await telegramBot.sendBuyNotification(buyResult, tokenData);

    console.log('Đang gửi sell notification...');
    const sellResult = {
      success: true,
      signature: '5X9...test_signature',
      mint: '69TDsqsWne8QMgVYDD1R5FbawBa8Sx11Mzh1CzWdpump'
    };
    await telegramBot.sendSellNotification(sellResult, 'TAKE_PROFIT', 150.5, 0.1505);

    console.log('✅ Đã gửi các thông báo thành công! Hãy kiểm tra channel Telegram.');
  } catch (err) {
    console.error('❌ Lỗi khi gửi alert:', err);
  }

  // Đợi một chút rồi thoát
  setTimeout(() => process.exit(0), 2000);
}

testAlert();
