// Danh sách hot wallet của các CEX trên Solana mainnet.
// Giữ ngắn gọn — user nên verify thêm qua Solscan tag và mở rộng qua env.
//
// Format env override: KNOWN_CEX_EXTRA="addr1:Binance,addr2:MEXC,addr3:Kucoin"
//
// CẢNH BÁO: hot wallet xoay vòng. Danh sách này cần được review định kỳ
// (gợi ý: 1 lần/tháng) đối chiếu với https://solscan.io/account/{addr}.

const HOTWALLETS = {
  // Binance
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'Binance',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'Binance',
  '3yFwqXBfZY4jBVUafQ1YEXw7recrNcbe3DsxL4eHrcEv': 'Binance',

  // Bybit
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'Bybit',
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2': 'Bybit',

  // OKX
  'ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ': 'OKX',
  '6QJzieMYfp7yr3EdrePaQoG3Ghxs2wM98xSLRu8Xh56U': 'OKX',

  // Coinbase
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS': 'Coinbase',
  '9qcWBtJzQbE3KhqVvY4wPq3uTvACzBqJKZ7jVbV5N5W2': 'Coinbase',

  // Kraken
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh17Yzz9FJrJEGEG': 'Kraken',

  // Kucoin
  'BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6': 'Kucoin',
  '6vmaerf3MX5G34QsR9MeJBBLmSEZLkxjTiRk2mZWzCcq': 'Kucoin',

  // MEXC (verify before prod)
  'AobVSwdW9BbpMdJvTqeCN4hPAmh4rHm7vwLnQLFtQyXd': 'MEXC',

  // Gate.io (verify before prod)
  'u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w': 'Gate',

  // Bitget (verify before prod)
  '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD': 'Bitget',
};

// Env override: KNOWN_CEX_EXTRA="addr:label,addr:label"
const ENV_EXTRA = (process.env.KNOWN_CEX_EXTRA || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .reduce((acc, entry) => {
    const idx = entry.indexOf(':');
    if (idx <= 0) return acc;
    const addr = entry.slice(0, idx).trim();
    const label = entry.slice(idx + 1).trim();
    if (addr) acc[addr] = label || 'CEX';
    return acc;
  }, {});

const FULL_HOTWALLETS = { ...HOTWALLETS, ...ENV_EXTRA };
const KNOWN_CEX_KEYS = new Set(Object.keys(FULL_HOTWALLETS));

function getCexLabel(addr) {
  return FULL_HOTWALLETS[addr] || null;
}

function isKnownCex(addr) {
  return typeof addr === 'string' && KNOWN_CEX_KEYS.has(addr);
}

module.exports = {
  HOTWALLETS: FULL_HOTWALLETS,
  KNOWN_CEX_KEYS,
  getCexLabel,
  isKnownCex,
};
