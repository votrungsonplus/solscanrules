// Smart money whitelist — ví có lịch sử PnL realized dương trên nhiều token.
// Bot KHÔNG tự tính PnL trong scope này; user cần cung cấp danh sách offline
// (Solscan smart-money tag, Birdeye trader leaderboard, GMGN top trader, v.v.)
//
// 3 nguồn (gộp lại, env > file > hardcode):
//   1. Hardcode (file này) — bộ mặc định bot ship kèm
//   2. File optional: data/smart-money.json — { "addr": "label", ... }
//   3. Env: SMART_MONEY_WALLETS="addr1:Label1,addr2:Label2"
//
// Format file JSON:
//   {
//     "DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj": "Top Trader X",
//     "...": "..."
//   }

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Bộ hardcode — để rỗng, user nên tự build danh sách phù hợp với risk profile.
// Ví dụ thêm: "DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj": "Public top trader"
const HARDCODE = {};

function loadFromFile() {
  const filePath = process.env.SMART_MONEY_FILE
    || path.join(process.cwd(), 'data', 'smart-money.json');
  try {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (err) {
    logger.warn(`Failed to load smart-money file (${filePath}): ${err.message}`);
  }
  return {};
}

function loadFromEnv() {
  const out = {};
  const raw = process.env.SMART_MONEY_WALLETS || '';
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const addr = trimmed.slice(0, idx).trim();
    const label = trimmed.slice(idx + 1).trim() || 'Smart Money';
    if (addr) out[addr] = label;
  }
  return out;
}

const WALLETS = {
  ...HARDCODE,
  ...loadFromFile(),
  ...loadFromEnv(),
};

const ADDRESSES = new Set(Object.keys(WALLETS));

function isSmartMoney(addr) {
  return typeof addr === 'string' && ADDRESSES.has(addr);
}

function getLabel(addr) {
  return WALLETS[addr] || null;
}

function size() {
  return ADDRESSES.size;
}

module.exports = {
  WALLETS,
  ADDRESSES,
  isSmartMoney,
  getLabel,
  size,
};
