const { LAMPORTS_PER_SOL } = require('@solana/web3.js');

/**
 * Convert lamports to SOL
 */
function lamportsToSol(lamports) {
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Convert SOL to lamports
 */
function solToLamports(sol) {
  return Math.floor(sol * LAMPORTS_PER_SOL);
}

/**
 * Sleep for ms milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * 429 errors get shorter initial delay (rate limiter handles spacing)
 */
async function retry(fn, maxRetries = 3, baseDelay = 500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      const is429 = err.message && (err.message.includes('429') || err.message.includes('Too Many Requests'));
      const delay = is429
        ? 300 * Math.pow(2, i)   // 429: 300ms, 600ms, 1200ms (rate limiter does the rest)
        : baseDelay * Math.pow(2, i); // other: 500ms, 1000ms, 2000ms
      await sleep(delay);
    }
  }
}

/**
 * Shorten a Solana address for display
 */
function shortenAddress(address, chars = 4) {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Format SOL amount
 */
function formatSol(amount) {
  return `${amount.toFixed(4)} SOL`;
}

/**
 * Get current timestamp in seconds
 */
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Calculate PumpFun Virtual Market Cap in SOL
 * Formula: (vSol / vTokens) * 1,000,000,000
 */
function calculatePumpFunMcap(vSol, vTokens) {
  if (!vSol || !vTokens || vTokens === 0) return 0;
  const totalSupply = 1000000000;
  return (vSol / vTokens) * totalSupply;
}

module.exports = {
  lamportsToSol,
  solToLamports,
  sleep,
  retry,
  shortenAddress,
  formatSol,
  nowSeconds,
  calculatePumpFunMcap,
};
