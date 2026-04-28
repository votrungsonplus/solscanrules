// 8 địa chỉ Jito tip account chính thức trên mainnet.
// Nguồn: https://jito-labs.gitbook.io/mev/searcher-resources/bundles/rpc-api-reference/sendbundle
// Mọi Jito Bundle THẬT đều có ít nhất 1 tx chuyển SOL tới một trong các địa chỉ này.
// Cho phép env JITO_TIP_ACCOUNTS override (vẫn dùng để gửi tip khi mua).
const ENV_OVERRIDE = (process.env.JITO_TIP_ACCOUNTS || '')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);

const OFFICIAL_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqyUv6nBp6tWN6nU9Xh7hF6R3vJ2vG9K2U3',
  'Cw8CFyM9FxyqyPbS7WvB6K8vTXL8f5uR36Dq79RgnBKy',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDe9B',
  'ADuUkR4vqLUMWXxW9gh6D6L8pivKeVQDbiRfACBz4qWo',
  'DttWaMuZ9ST4itv7NreTC99vY56unz7FcPjs1461g4U6',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const TIP_ACCOUNTS = new Set([
  ...OFFICIAL_TIP_ACCOUNTS,
  ...ENV_OVERRIDE,
]);

function isJitoTipAccount(addr) {
  return typeof addr === 'string' && TIP_ACCOUNTS.has(addr);
}

// Trả true nếu parsedTransaction có ít nhất 1 instruction SystemProgram.transfer
// tới một địa chỉ Jito tip → tx này là một phần của Jito Bundle.
function hasJitoTipTransfer(parsedTx) {
  if (!parsedTx?.transaction?.message) return false;

  // Top-level instructions
  const topIxs = parsedTx.transaction.message.instructions || [];
  for (const ix of topIxs) {
    const dest = ix?.parsed?.info?.destination;
    if (ix?.parsed?.type === 'transfer' && isJitoTipAccount(dest)) return true;
  }

  // Inner instructions (CPI) — bundle có thể tip qua CPI
  const inner = parsedTx?.meta?.innerInstructions || [];
  for (const block of inner) {
    for (const ix of block.instructions || []) {
      const dest = ix?.parsed?.info?.destination;
      if (ix?.parsed?.type === 'transfer' && isJitoTipAccount(dest)) return true;
    }
  }

  return false;
}

module.exports = {
  TIP_ACCOUNTS,
  OFFICIAL_TIP_ACCOUNTS,
  isJitoTipAccount,
  hasJitoTipTransfer,
};
