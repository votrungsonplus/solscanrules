const axios = require('axios');
require('dotenv').config();

const urls = (process.env.SOLANA_RPC_URLS || '').split(',').map(u => u.trim()).filter(u => u);

async function test() {
  console.log('--- RPC Health Check (Current .env) ---');
  if (urls.length === 0) {
    console.log('No RPC URLs found in .env!');
    return;
  }

  for (let i = 0; i < urls.length; i++) {
    const start = Date.now();
    try {
      const res = await axios.post(urls[i], {
        jsonrpc: '2.0',
        id: 1,
        method: 'getHealth'
      }, { timeout: 8000 });
      console.log(`RPC #${i+1}: OK (${Date.now() - start}ms) - Result: ${JSON.stringify(res.data.result)}`);
    } catch (e) {
      let errorDetail = e.message;
      if (e.response) {
        errorDetail += ` (Status: ${e.response.status}, Data: ${JSON.stringify(e.response.data)})`;
      }
      console.log(`RPC #${i+1}: FAILED (${errorDetail})`);
    }
  }
}

test();
