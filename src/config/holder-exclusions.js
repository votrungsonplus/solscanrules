// Tập hợp các địa chỉ KHÔNG phải holder thật, cần loại khỏi tính toán % concentration.
// Bao gồm: PumpFun system, Raydium AMM authority, burn/dead address, system program,
// và token program (gặp khi RPC trả nhầm).

const PUMPFUN_SYSTEM = [
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', // PumpFun migration authority
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ2j6BgsF66z', // PumpFun fee account
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1', // PumpFun fee account 2
  'CebN5WGZ4jvStp3MLuW6S6T4Ez7B4PmezeNVasJp69ov', // Legacy/alt migration authority
  'TSLvddqTZ24pYp3zXW728EKEpCKA8atuVnJkz78S79z',  // Legacy global fee account
  '4e6eTeeM9ojnT2D1297q6NngaMgChA3mZTXdRvs5xPz7', // Additional PumpFun system wallet
  '6pjkAgzWJvqxVbwwumU1gin5pDyDdM2eaNXKTv3B7NPN', // Additional PumpFun system wallet
];

const DEX_AUTHORITY = [
  '5Q544fKrMJu97H5G98M5QXT7sAUPtUvyP5D9S6gBfGnd', // Raydium AMM authority V4
];

// Các địa chỉ đốt token / dead address chuẩn của Solana.
// Token gửi tới đây = đã burn → KHÔNG tính vào circulating, KHÔNG tính vào top holder.
const BURN_DEAD = [
  '1nc1nerator11111111111111111111111111111111', // Solana incinerator (canonical burn)
  '11111111111111111111111111111111',             // System Program (token tới đây = locked vĩnh viễn)
  'deadbe111111111111111111111111111111111111',  // Quy ước cộng đồng (nếu xuất hiện)
];

// Token program — gặp khi RPC trả nhầm token account của program.
const TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token legacy
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
];

// Cho phép user thêm địa chỉ qua env (multisig/lock contract đặc biệt).
const ENV_EXTRA = (process.env.HOLDER_EXTRA_EXCLUDED_OWNERS || '')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);

const EXCLUDED_OWNERS = new Set([
  ...PUMPFUN_SYSTEM,
  ...DEX_AUTHORITY,
  ...BURN_DEAD,
  ...TOKEN_PROGRAMS,
  ...ENV_EXTRA,
]);

const BURN_OWNERS = new Set(BURN_DEAD);

function isExcludedOwner(addr) {
  return typeof addr === 'string' && EXCLUDED_OWNERS.has(addr);
}

function isBurnOwner(addr) {
  return typeof addr === 'string' && BURN_OWNERS.has(addr);
}

module.exports = {
  EXCLUDED_OWNERS,
  BURN_OWNERS,
  PUMPFUN_SYSTEM,
  DEX_AUTHORITY,
  BURN_DEAD,
  TOKEN_PROGRAMS,
  isExcludedOwner,
  isBurnOwner,
};
