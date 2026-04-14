const { Telegraf, Markup } = require('telegraf');
const settings = require('../config/settings');
const logger = require('../utils/logger');
const { shortenAddress, formatSol } = require('../utils/helpers');

// Escape special HTML characters to prevent Telegram parse errors
function esc(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class TelegramBot {
  constructor() {
    this.bot = null;
    this.isRunning = false;
    this.onCommandCallback = null;
    this.lastSellNotifications = new Map(); // mint -> timestamp
  }

  /**
   * Initialize Telegram bot
   */
  init(onCommand) {
    if (!settings.telegram.botToken) {
      logger.warn('Telegram bot token not configured - notifications disabled');
      return this;
    }

    this.onCommandCallback = onCommand;
    this.bot = new Telegraf(settings.telegram.botToken);
    this._registerCommands();

    logger.info('Telegram bot initialized');
    return this;
  }

  /**
   * Start the Telegram bot
   */
  async start() {
    if (!this.bot) return;

    try {
      logger.info('Connecting to Telegram API...');
      const me = await this.bot.telegram.getMe();
      logger.info(`Connected as @${me.username}. Registering commands...`);
      
      // Register command menu
      await this.bot.telegram.setMyCommands([
        { command: 'start', description: 'Hiển thị menu commands' },
        { command: 'status', description: 'Trạng thái bot & balance' },
        { command: 'wallet', description: 'Thông tin ví & Số dư' },
        { command: 'positions', description: 'Các vị thế đang mở' },
        { command: 'pnl', description: 'Lãi/lỗ hôm nay' },
        { command: 'history', description: 'Lịch sử giao dịch' },
        { command: 'rules', description: 'Danh sách rules đang hoạt động' },
        { command: 'reset', description: 'Khởi động lại Bot' },
        { command: 'reset_pnl', description: 'Xóa trắng lãi lỗ & vị thế' },
        { command: 'config', description: 'Xem toàn bộ cấu hình hiện tại' },
        { command: 'pause', description: 'Tạm dừng bot' },
        { command: 'resume', description: 'Chạy lại bot' },
      ]);

      logger.info('Telegram commands set. Launching polling...');
      
      // Launch with dropPendingUpdates to clear potential poll conflicts
      await this.bot.launch({ dropPendingUpdates: true });
      
      this.isRunning = true;
      logger.info('Telegram bot successfully started and online');

      // Notify user
      const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      await this.sendMessage(`🤖 <b>SCAN SOL BOT ĐÃ KHỞI ĐỘNG</b>\n⏰ Thời gian: <code>${now}</code>\n\nĐang quét PumpFun tìm token mới...`);
    } catch (err) {
      logger.error(`Failed to start Telegram bot: ${err.message}`);
      throw err;
    }
  }

  stop() {
    if (this.bot) {
      this.bot.stop();
      this.isRunning = false;
    }
  }

  _registerCommands() {
    // /start - Welcome
    this.bot.start((ctx) => {
      ctx.replyWithMarkdown(
        '*🤖 SCAN SOL BOT*\n\n' +
        '*📋 Danh sách lệnh:*\n\n' +
        '📊 *Theo dõi:*\n' +
        '/status — Trạng thái bot, số dư ví\n' +
        '/positions — Các vị thế đang mở\n' +
        '/pnl — Lãi/lỗ trong ngày\n' +
        '/history — Lịch sử giao dịch gần nhất\n\n' +
        '⚙️ *Cấu hình:*\n' +
        '/config — Xem toàn bộ cấu hình hiện tại\n' +
        '/rules — Xem điều kiện lọc kèo (chi tiết)\n' +
        '/toggle\\_rule <id> — Bật/tắt điều kiện\n\n' +
        '💰 *Giao dịch:*\n' +
        '/set\\_amount <sol> — Đặt số SOL mua mỗi lệnh\n' +
        '/set\\_tp <phần trăm> — Đặt chốt lời %\n' +
        '/set\\_sl <phần trăm> — Đặt cắt lỗ %\n' +
        '/auto\\_buy <on|off> — Bật/tắt tự động mua\n' +
        '/sell <mint> — Bán token thủ công\n\n' +
        '🔍 *Quét kèo:*\n' +
        '/set\\_mcap <sol> — Đặt vốn hoá tối thiểu (SOL)\n' +
        '/set\\_buyers <số> — Số ví mua sớm cần theo dõi\n' +
        '/set\\_fee <sol> — Ngưỡng Global Fee tối thiểu\n\n' +
        '🔄 *Điều khiển:*\n' +
        '/pause — Tạm dừng bot\n' +
        '/resume — Chạy lại bot'
      );
    });

    // /status & /wallet
    this.bot.command(['status', 'wallet'], (ctx) => {
      this._handleCommand('status', {}, ctx);
    });

    // /positions
    this.bot.command('positions', (ctx) => {
      this._handleCommand('positions', {}, ctx);
    });

    // /pnl
    this.bot.command('pnl', (ctx) => {
      this._handleCommand('pnl', {}, ctx);
    });

    // /rules
    this.bot.command('rules', (ctx) => {
      this._handleCommand('rules', {}, ctx);
    });

    // /toggle_rule <id>
    this.bot.command('toggle_rule', (ctx) => {
      const parts = ctx.message.text.split(/\s+/);
      const ruleId = parts[1];
      this._handleCommand('toggle_rule', { ruleId }, ctx);
    });

    // /set_mcap <sol>
    this.bot.command('set_mcap', (ctx) => {
      const parts = ctx.message.text.split(/\s+/);
      const amount = parseFloat(parts[1]);
      this._handleCommand('set_mcap', { amount }, ctx);
    });

    // /set_amount <sol>
    this.bot.command('set_amount', (ctx) => {
      const parts = ctx.message.text.split(/\s+/);
      const amount = parseFloat(parts[1]);
      this._handleCommand('set_amount', { amount }, ctx);
    });

    // /set_tp <percent>
    this.bot.command('set_tp', (ctx) => {
      const parts = ctx.message.text.split(/\s+/);
      const percent = parseFloat(parts[1]);
      this._handleCommand('set_tp', { percent }, ctx);
    });

    // /set_sl <percent>
    this.bot.command('set_sl', (ctx) => {
      const parts = ctx.message.text.split(/\s+/);
      const percent = parseFloat(parts[1]);
      this._handleCommand('set_sl', { percent }, ctx);
    });

    // /auto_buy
    this.bot.command('auto_buy', (ctx) => {
      const parts = ctx.message.text.split(/\s+/);
      const value = parts[1];
      this._handleCommand('auto_buy', { enabled: value === 'on' }, ctx);
    });

    // /sell <mint>
    this.bot.command('sell', (ctx) => {
      const parts = ctx.message.text.split(/\s+/);
      const mint = parts[1];
      this._handleCommand('sell', { mint }, ctx);
    });

    // /history
    this.bot.command('history', (ctx) => {
      this._handleCommand('history', {}, ctx);
    });

    // /config
    this.bot.command('config', (ctx) => this._handleCommand('config', {}, ctx));

    // /set_buyers <count>
    this.bot.command('set_buyers', (ctx) => {
      const parts = ctx.message.text.split(/\s+/);
      const count = parseInt(parts[1]);
      this._handleCommand('set_buyers', { count }, ctx);
    });

    // /set_fee <threshold>
    this.bot.command('set_fee', (ctx) => {
      const parts = ctx.message.text.split(/\s+/);
      const threshold = parseFloat(parts[1]);
      this._handleCommand('set_fee', { threshold }, ctx);
    });

    // /pause & /resume
    this.bot.command('pause', (ctx) => this._handleCommand('pause', {}, ctx));
    this.bot.command('resume', (ctx) => this._handleCommand('resume', {}, ctx));

    // /reset
    this.bot.command('reset', (ctx) => this._handleCommand('reset', {}, ctx));

    // /reset_pnl
    this.bot.command('reset_pnl', (ctx) => this._handleCommand('reset_pnl', {}, ctx));

    // Handle inline button callbacks
    this.bot.on('callback_query', (ctx) => {
      const data = ctx.callbackQuery.data;
      if (data.startsWith('buy:')) {
        const mint = data.split(':')[1];
        this._handleCommand('confirm_buy', { mint }, ctx);
        ctx.answerCbQuery('Đã gửi lệnh mua!');
      } else if (data.startsWith('skip:')) {
        ctx.answerCbQuery('Đã bỏ qua');
        ctx.editMessageReplyMarkup(undefined);
      } else if (data.startsWith('wallet:')) {
        const action = data.split(':')[1];
        if (action === 'reset_pnl_confirmed') {
          this._handleCommand('reset_pnl', { confirmed: true }, ctx);
        } else {
          this._handleCommand(action, {}, ctx);
        }
        ctx.answerCbQuery();
      }
    });
  }

  async _handleCommand(command, params, ctx) {
    const fromId = ctx.from ? ctx.from.id : 'unknown';
    const fromUser = ctx.from ? ctx.from.username : 'unknown';
    logger.info(`Telegram: Received /${command} from @${fromUser} (${fromId})`);

    if (this.onCommandCallback) {
      try {
        const result = await this.onCommandCallback(command, params);
        if (result) {
          let text = result;
          let extra = {};

          // Handle structured response (object with text and keyboard)
          if (typeof result === 'object' && result.text) {
            text = result.text;
            if (result.keyboard) {
              extra = Markup.inlineKeyboard(result.keyboard);
            }
          }

          // Add default buttons for status/wallet commands if no custom keyboard provided
          if (!extra.inline_keyboard && ['status', 'positions', 'pnl', 'config', 'rules'].includes(command)) {
            extra = Markup.inlineKeyboard([
              [
                Markup.button.callback('🔄 Làm mới', 'wallet:status'),
                Markup.button.callback('📊 Vị thế', 'wallet:positions'),
              ],
              [
                Markup.button.callback('📈 PnL', 'wallet:pnl'),
                Markup.button.callback('⚙️ Cấu hình', 'wallet:config'),
              ]
            ]);
          }

          if (ctx.callbackQuery) {
            await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra }).catch(() => {});
          } else {
            await ctx.replyWithMarkdown(text, extra);
          }
          logger.info(`Telegram: Sent response for /${command}`);
        }
      } catch (err) {
        logger.error(`Telegram: Error handling /${command}: ${err.message}`);
        await ctx.reply(`❌ Lỗi hệ thống: ${err.message}`);
      }
    }
  }

  // ─── Notification Methods ─────────────────────────────────────────

  /**
   * Send a basic message
   */
  async sendMessage(text) {
    if (!this.bot || !settings.telegram.chatIds || settings.telegram.chatIds.length === 0) return;
    for (const chatId of settings.telegram.chatIds) {
      try {
        await this.bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error(`Telegram send error to ${chatId}: ${err.message}`);
      }
    }
  }

  /**
   * Send new token alert with buy/skip buttons
   */
  async sendNewTokenAlert(tokenData, analysisResult) {
    if (!this.bot || !settings.telegram.chatIds || settings.telegram.chatIds.length === 0) {
      logger.warn(`Telegram alert skipped: bot=${!!this.bot}, chatIds configured=${!!settings.telegram.chatIds?.length}`);
      return;
    }

    const { ruleResult, devAnalysis, clusterAnalysis, tokenScore, holderStats } = analysisResult;
    const ageMin = (Date.now() - tokenData.timestamp) / 60000;
    const volume = (tokenData.globalFee || 0) * 100;
    
    // Header & CA at the top for auto-check bots (Phanes, etc.)
    let text = `<code>${tokenData.mint}</code>\n\n`;
    text += `🆕 <b>PHÁT HIỆN TOKEN MỚI</b>\n`;
    text += `<b>${esc(tokenData.name)}</b> (${esc(tokenData.symbol)})\n`;
    text += `CA: <code>${tokenData.mint}</code>\n`;
    text += `Deployer: <code>${shortenAddress(tokenData.deployer)}</code>\n\n`;

    const fullMcapUsd = tokenData.marketCapUsd || 0;
    const fullMcapSol = tokenData.marketCapSol || 0;
    const circulatingMcapUsd = tokenData.circulatingMcapUsd || fullMcapUsd;
    const circulatingMcapSol = tokenData.circulatingMcapSol || fullMcapSol;

    text += `📊 <b>Thông số:</b>\n`;
    text += `• MC: <b>$${fullMcapUsd.toLocaleString(undefined, {maximumFractionDigits: 0})}</b> (${fullMcapSol.toFixed(2)} SOL)\n`;
    if (circulatingMcapUsd > 0 && Math.abs(circulatingMcapUsd - fullMcapUsd) > fullMcapUsd * 0.02) {
      text += `• MC lưu hành: $${circulatingMcapUsd.toLocaleString(undefined, {maximumFractionDigits: 0})} (${circulatingMcapSol.toFixed(2)} SOL)\n`;
    }
    text += `• Volume: ${volume.toFixed(1)} SOL\n`;
    text += `• Thời gian: ${ageMin.toFixed(1)} phút\n\n`;

    if (holderStats) {
      text += `👥 <b>Holders (% supply, trừ pool):</b>\n`;
      text += `• Holder thật: <b>${holderStats.realHolderCount ?? 0}</b>${typeof holderStats.filteredFunctionalCount === 'number' ? ` | Đã lọc: ${holderStats.filteredFunctionalCount}` : ''}\n`;
      text += `• Top 10: <b>${holderStats.top10Percent.toFixed(1)}%</b>${typeof holderStats.top10OwnersPercent === 'number' ? ` | Owners: ${holderStats.top10OwnersPercent.toFixed(1)}%` : ''}\n`;
      text += `• Dev: ${holderStats.devHoldPercent.toFixed(1)}%\n`;
      text += `• Bundle: ${holderStats.bundleHoldPercent.toFixed(1)}%\n`;
      text += `• Snipers: ${holderStats.earlyBuyerHoldPercent.toFixed(1)}%\n\n`;
    }

    // Cluster / Funder info
    if (clusterAnalysis && clusterAnalysis.sharedFunders.length > 0) {
      const isStrong = clusterAnalysis.sharedFunders.length >= 3;
      text += `🔗 <b>${isStrong ? '✅ TÍN HIỆU CABAL (WINNER)' : '🔗 Nguồn cấp tiền (Chia tiền)'}:</b>\n`;
      for (const funder of clusterAnalysis.sharedFunders) {
        text += `  → <code>${shortenAddress(funder.address)}</code> | <b>${funder.sharedBy} ví con</b>\n`;
      }
      text += `\n`;
    }

    // All rule conditions with pass/fail status
    text += `🛡 <b>Chi tiết lọc kèo (Pass):</b>\n`;
    for (const r of ruleResult.results) {
      if (!r.passed && r.ruleType === 'INFO') continue;
      const icon = r.passed ? '✅' : '❌';
      text += `${icon} <b>${esc(r.ruleName)}</b>\n`;
      const lines = r.reason.split('\n');
      for (const line of lines) {
        if (line.trim()) text += `    └─ <i>${esc(line.trim())}</i>\n`;
      }
    }
    text += `\n🏁 <b>Kết luận:</b> ${esc(ruleResult.summary)}\n\n`;

    if (devAnalysis) {
      text += `<b>Rủi ro Dev:</b> ${devAnalysis.riskScore}/100 (${esc(devAnalysis.riskLevel)})\n`;
    }

    if (tokenScore) {
      text += `<b>Điểm token:</b> ${tokenScore.totalScore}/100 (${esc(tokenScore.verdict)})\n`;
    }

    // Explicit command for other bots
    text += `\n<code>/pnl ${tokenData.mint}</code>\n`;

    // Inline Buttons
    const buttons = [];
    
    // Row 1: Quick tool links
    buttons.push([
      Markup.button.url('📈 DexScreener', `https://dexscreener.com/solana/${tokenData.mint}`),
      Markup.button.url('🤖 Phanes Bot', `https://t.me/Phanes_bot?start=${tokenData.mint}`),
    ]);

    // Row 2: Trading or Info
    if (ruleResult.shouldBuy && !settings.trading.autoBuyEnabled) {
      buttons.push([
        Markup.button.callback(`🛒 Mua ${formatSol(settings.trading.buyAmountSol)}`, `buy:${tokenData.mint}`),
        Markup.button.callback('⏭ Bỏ qua', `skip:${tokenData.mint}`),
      ]);
    } else {
      buttons.push([
        Markup.button.url('🍬 PumpFun', `https://pump.fun/coin/${tokenData.mint}`),
        Markup.button.url('📊 Birdeye', `https://birdeye.so/token/${tokenData.mint}?chain=solana`),
      ]);
    }

    const keyboard = Markup.inlineKeyboard(buttons);

    for (const chatId of settings.telegram.chatIds) {
      try {
        await this.bot.telegram.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          ...keyboard,
        });
      } catch (err) {
        logger.error(`Telegram alert error to ${chatId}: ${err.message}`);
      }
    }
  }

  /**
   * Send buy execution notification
   */
  async sendBuyNotification(buyResult, tokenData) {
    const emoji = buyResult.success ? '✅' : '❌';
    let text = `${emoji} <b>${buyResult.success ? 'Đã mua' : 'Mua thất bại'}</b>\n\n`;
    text += `Token: ${esc(tokenData.symbol)}\n`;
    text += `CA: <code>${tokenData.mint}</code>\n`;
    text += `Số tiền: ${formatSol(buyResult.solAmount)}\n`;

    if (buyResult.success) {
      text += `TX: <a href="https://solscan.io/tx/${buyResult.signature}">${buyResult.signature.slice(0, 8)}...</a>\n`;
    } else {
      text += `Lỗi: ${esc(buyResult.error)}\n`;
    }

    await this.sendMessage(text);
  }

  /**
   * Send sell notification (TP/SL/Anti-rug)
   */
  async sendSellNotification(sellResult, reason, pnlPercent, pnlSol, walletSummary) {
    // 🛡 Anti-spam: Debounce duplicate notifications for the same token (30s window)
    const now = Date.now();
    const lastNotify = this.lastSellNotifications.get(sellResult.mint);
    if (lastNotify && (now - lastNotify < 30000)) {
      logger.info(`[Telegram] Debounced duplicate notification for ${sellResult.mint} (${reason})`);
      return;
    }

    // Only cache if it's a success to allow retries on failure to show up eventually
    if (sellResult.success) {
      this.lastSellNotifications.set(sellResult.mint, now);
    }

    const reasonMap = {
      TAKE_PROFIT: { emoji: '🎯', text: 'Chốt lời' },
      STOP_LOSS: { emoji: '🛑', text: 'Cắt lỗ' },
      ANTI_RUG: { emoji: '🚨', text: 'Chống rug' },
      MANUAL: { emoji: '👤', text: 'Bán thủ công' },
    };
    const r = reasonMap[reason] || { emoji: '🔄', text: reason };

    let text = `${r.emoji} <b>Đã bán — ${r.text}</b>\n\n`;
    text += `Token: <code>${sellResult.mint}</code>\n`; // Show full CA for trackers
    text += `Lãi/lỗ: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%${pnlSol !== null ? ` (${pnlSol >= 0 ? '+' : ''}${formatSol(pnlSol)})` : ''}\n`;

    if (sellResult.success) {
      text += `TX: <a href="https://solscan.io/tx/${sellResult.signature}">${sellResult.signature.slice(0, 8)}...</a>\n`;
    } else {
      text += `Lỗi: ${sellResult.error}\n`;
    }

    if (walletSummary) {
      const totalPnlSol = walletSummary.equitySol - walletSummary.initialBalanceSol;
      const totalPnlPercent = (totalPnlSol / walletSummary.initialBalanceSol) * 100;

      text += `\n💰 <b>Số dư ví ảo:</b>\n`;
      text += `• Hiện tại: ${formatSol(walletSummary.equitySol)}\n`;
      text += `• Tổng lãi/lỗ: ${totalPnlSol >= 0 ? '+' : ''}${formatSol(totalPnlSol)} (${totalPnlSol >= 0 ? '+' : ''}${totalPnlPercent.toFixed(1)}%)`;
    }

    await this.sendMessage(text);
  }

  /**
   * Send daily PnL summary
   */
  async sendDailySummary(summary, winRateStats) {
    let text = `📊 <b>Tổng kết ngày</b>\n\n`;
    text += `Token đã quét: ${summary.tokensScanned}\n`;
    text += `Token đã mua: ${summary.tokensBought}\n`;
    text += `Token đã bán: ${summary.tokensSold}\n`;
    text += `Tổng lãi/lỗ: ${summary.totalPnl >= 0 ? '+' : ''}${formatSol(summary.totalPnl)}\n`;
    text += `Tỷ lệ thắng: ${summary.winRate.toFixed(1)}%\n`;

    if (winRateStats) {
      const fmt = (d) => d && d.total > 0 ? `${d.winRate.toFixed(1)}% (${d.wins}W/${d.losses}L)${d.avgPnlPercent !== undefined ? ` | PnL: ${d.avgPnlPercent >= 0 ? '+' : ''}${d.avgPnlPercent.toFixed(1)}%` : ''}` : 'N/A';
      text += `\n📊 <b>Win Rate (ATH PnL):</b>\n`;
      text += `• Hôm nay (9h): ${fmt(winRateStats['1d'])}\n`;
      text += `• 3D: ${fmt(winRateStats['3d'])}\n`;
      text += `• 7D: ${fmt(winRateStats['7d'])}\n`;
      text += `• ALL: ${fmt(winRateStats['all'])}\n`;
    }

    await this.sendMessage(text);
  }
}

module.exports = new TelegramBot();
