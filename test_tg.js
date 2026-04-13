require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const chatIds = process.env.TELEGRAM_CHAT_ID.split(',');

function esc(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function test() {
  const text = `<code>1111</code>\n\n🆕 <b>PHÁT HIỆN TOKEN MỚI</b>\n<b>Token</b> (TKN)\nCA: <code>111</code>\nDeployer: <code>111</code>\n\n`;
  for(let id of chatIds) {
     try {
       await bot.telegram.sendMessage(id, text, { parse_mode: 'HTML' });
       console.log("Success to " + id);
     } catch(e) {
       console.log("Error to " + id + ": " + e.message);
     }
  }
}
test();
