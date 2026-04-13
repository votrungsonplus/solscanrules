require('dotenv').config();

const { Connection, PublicKey } = require('@solana/web3.js');

async function main() {
  const mintStr = process.argv[2];
  if (!mintStr) {
    console.error('Usage: node debug-top10.js <mint>');
    process.exit(1);
  }

  const rpcUrls = (process.env.SOLANA_RPC_URLS || 'https://api.mainnet-beta.solana.com')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  const conn = new Connection(rpcUrls[0], 'confirmed');
  const mint = new PublicKey(mintStr);

  const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const TOKEN_LEGACY = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

  const [bondingCurvePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM
  );

  const excludedOwners = new Set([
    bondingCurvePDA.toBase58(),
    '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
    'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ2j6BgsF66z',
    'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1',
    'CebN5WGZ4jvStp3MLuW6S6T4Ez7B4PmezeNVasJp69ov',
    'TSLvddqTZ24pYp3zXW728EKEpCKA8atuVnJkz78S79z',
    '5Q544fKrMJu97H5G98M5QXT7sAUPtUvyP5D9S6gBfGnd',
  ]);
  const excludedAccounts = new Set();

  for (const tokenProgram of [TOKEN_LEGACY, TOKEN_2022]) {
    try {
      const [ata] = PublicKey.findProgramAddressSync(
        [bondingCurvePDA.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM
      );
      excludedAccounts.add(ata.toBase58());
    } catch {}
  }

  const [largestAccounts, supplyRes] = await Promise.all([
    conn.getTokenLargestAccounts(mint),
    conn.getTokenSupply(mint),
  ]);

  const decimals = supplyRes?.value?.decimals ?? largestAccounts.value?.[0]?.decimals ?? 6;
  const divisor = Math.pow(10, decimals);
  const supply = parseFloat(supplyRes.value.amount) / divisor;

  console.log(`mint=${mintStr}`);
  console.log(`decimals=${decimals}`);
  console.log(`supply=${supply}`);
  console.log(`bondingCurvePDA=${bondingCurvePDA.toBase58()}`);

  for (const acc of largestAccounts.value.slice(0, 20)) {
    const addr = acc.address.toBase58 ? acc.address.toBase58() : String(acc.address);
    const amount = acc.uiAmount != null
      ? acc.uiAmount
      : acc.uiAmountString
        ? parseFloat(acc.uiAmountString)
        : parseFloat(acc.amount) / divisor;

    let owner = null;
    try {
      const parsed = await conn.getParsedAccountInfo(new PublicKey(addr));
      owner = parsed?.value?.data?.parsed?.info?.owner || null;
    } catch {}

    const excluded = excludedAccounts.has(addr) || (owner && excludedOwners.has(owner));
    const percent = supply > 0 ? (amount / supply) * 100 : 0;

    console.log(JSON.stringify({
      account: addr,
      owner,
      amount,
      percent: Number(percent.toFixed(4)),
      excluded,
    }));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
