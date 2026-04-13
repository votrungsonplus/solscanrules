const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

const MINT = '4ko6t6ud4ddqFYpdsrGdoJLL1sCE8R2NUhApeWQepump';
const RPC = 'https://mainnet.helius-rpc.com/?api-key=ed588590-bcb6-41ee-bd7a-0de8a2aecb15';
const conn = new Connection(RPC);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function short(addr) { return addr.slice(0, 6) + '...' + addr.slice(-4); }

async function analyzeWallet(addr) {
  const pubkey = new PublicKey(addr);
  const sigs = await conn.getSignaturesForAddress(pubkey, { limit: 20 });
  await sleep(400);
  const txCount = sigs.length;
  const oldest = sigs.length > 0 ? sigs[sigs.length - 1] : null;
  const ageSec = oldest ? Date.now() / 1000 - oldest.blockTime : 0;
  const ageDays = Math.floor(ageSec / 86400);
  const isWhite = txCount <= 5 && ageSec < 7 * 86400;

  // Get funding source from oldest txs
  const fundingWallets = [];
  const oldestSigs = sigs.slice(-3);
  for (const sig of oldestSigs) {
    try {
      const tx = await conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      await sleep(300);
      if (!tx?.meta || !tx?.transaction?.message) continue;
      const accounts = tx.transaction.message.accountKeys.map(k => {
        if (typeof k === 'string') return k;
        if (k.pubkey?.toBase58) return k.pubkey.toBase58();
        return k.pubkey || '';
      });
      const pre = tx.meta.preBalances || [];
      const post = tx.meta.postBalances || [];

      for (let i = 0; i < accounts.length; i++) {
        if (accounts[i] === addr && (post[i] - pre[i]) > 1000000) {
          for (let j = 0; j < accounts.length; j++) {
            if (j !== i && (post[j] - pre[j]) < -1000000) {
              const sender = accounts[j];
              if (sender !== '11111111111111111111111111111111' && !fundingWallets.includes(sender)) {
                fundingWallets.push(sender);
              }
            }
          }
        }
      }
    } catch (e) {}
  }

  return { address: addr, txCount, ageDays, isWhite, label: isWhite ? 'VÍ TRẮNG' : 'Ví cũ', fundingWallets };
}

async function analyzeFunder(addr) {
  const pubkey = new PublicKey(addr);
  const sigs = await conn.getSignaturesForAddress(pubkey, { limit: 10 });
  await sleep(300);
  const txCount = sigs.length;
  const oldest = sigs.length > 0 ? sigs[sigs.length - 1] : null;
  const ageSec = oldest ? Date.now() / 1000 - oldest.blockTime : 0;
  const ageDays = Math.floor(ageSec / 86400);
  const isWhite = txCount <= 5 && ageSec < 7 * 86400;
  return { address: addr, txCount, ageDays, isWhite, label: isWhite ? 'VÍ TRẮNG' : 'Ví cũ' };
}

async function main() {
  console.log(`\n🔍 Phân tích token: ${MINT}\n`);

  // Use Helius DAS API to get token trades
  console.log('Đang lấy early trades từ Helius...');

  // Parse transactions directly with better detection
  const mintPubkey = new PublicKey(MINT);
  const sigs = await conn.getSignaturesForAddress(mintPubkey, { limit: 50 });
  await sleep(500);

  const chronological = [...sigs].reverse();
  console.log(`Tổng signatures: ${chronological.length}`);

  const trades = [];
  let deployer = null;

  // Parse each tx to find buyers
  for (const sig of chronological.slice(0, 20)) {
    try {
      const tx = await conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      await sleep(350);
      if (!tx?.meta || !tx?.transaction?.message) continue;

      const accounts = tx.transaction.message.accountKeys.map(k => {
        if (typeof k === 'string') return k;
        if (k.pubkey?.toBase58) return k.pubkey.toBase58();
        return k.pubkey || '';
      });

      const logs = tx.meta.logMessages || [];
      const logsStr = logs.join('\n');

      // Detect create
      if (!deployer && (logsStr.includes('InitializeMint') || logsStr.includes('Program log: Instruction: Create'))) {
        deployer = accounts[0];
      }

      // Detect PumpFun buy instruction
      const hasPumpBuy = logsStr.includes('Program log: Instruction: Buy') && logsStr.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
      if (!hasPumpBuy) continue;

      const buyer = accounts[0]; // signer
      if (trades.find(t => t.trader === buyer)) continue;

      // Calculate SOL spent from balance changes
      const pre = tx.meta.preBalances || [];
      const post = tx.meta.postBalances || [];
      const solDiff = Math.abs((post[0] - pre[0]) / 1e9);

      if (solDiff > 0.001) {
        trades.push({ trader: buyer, solAmount: solDiff, sig: sig.signature.slice(0, 12) });
      }

      if (trades.length >= 10) break;
    } catch (e) {}
  }

  console.log(`Deployer: ${deployer || 'N/A'}`);
  console.log(`Early buyers: ${trades.length}\n`);

  if (trades.length === 0) {
    console.log('Không tìm được buyer từ parsed tx. Thử Helius enhanced API...');

    // Fallback: try Helius enhanced transactions API
    try {
      const resp = await axios.post(RPC, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [MINT, { limit: 20 }]
      });
      const enhancedSigs = resp.data.result || [];
      console.log(`Enhanced sigs: ${enhancedSigs.length}`);

      for (const s of [...enhancedSigs].reverse().slice(0, 15)) {
        try {
          const txResp = await axios.post(RPC, {
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
          });
          await sleep(400);
          const tx = txResp.data.result;
          if (!tx) continue;

          const logs = (tx.meta?.logMessages || []).join('\n');
          if (!logs.includes('Instruction: Buy')) continue;

          const accounts = tx.transaction.message.accountKeys.map(k =>
            typeof k === 'string' ? k : k.pubkey || ''
          );
          const buyer = accounts[0];
          if (trades.find(t => t.trader === buyer)) continue;

          const pre = tx.meta.preBalances || [];
          const post = tx.meta.postBalances || [];
          const diff = Math.abs((post[0] - pre[0]) / 1e9);
          if (diff > 0.001) {
            trades.push({ trader: buyer, solAmount: diff });
          }
          if (trades.length >= 5) break;
        } catch (e) {}
      }
    } catch (e) {
      console.log('Enhanced API failed:', e.message);
    }
  }

  if (trades.length === 0) {
    // Last resort: just grab unique signers from recent txs
    console.log('\nFallback: lấy signers từ các giao dịch gần nhất...');
    for (const sig of chronological.slice(0, 15)) {
      try {
        const tx = await conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
        await sleep(350);
        if (!tx?.meta || !tx?.transaction?.message) continue;

        const accounts = tx.transaction.message.accountKeys.map(k => {
          if (typeof k === 'string') return k;
          if (k.pubkey?.toBase58) return k.pubkey.toBase58();
          return k.pubkey || '';
        });

        const signer = accounts[0];
        const pre = tx.meta.preBalances || [];
        const post = tx.meta.postBalances || [];
        const diff = (post[0] - pre[0]) / 1e9;

        // Print for debugging
        const logs = (tx.meta.logMessages || []);
        const relevantLogs = logs.filter(l => l.includes('Instruction:') || l.includes('Program log:'));
        console.log(`\nTx: ${sig.signature.slice(0, 12)}`);
        console.log(`  Signer: ${short(signer)} | SOL diff: ${diff.toFixed(6)}`);
        console.log(`  Logs: ${relevantLogs.slice(0, 5).join(' | ')}`);

        if (trades.length >= 8) break;
      } catch (e) {}
    }
    return;
  }

  // Continue with analysis...
  const buyerEntries = trades.slice(0, 5);
  const amounts = buyerEntries.map(t => t.solAmount);
  const totalVolume = amounts.reduce((s, a) => s + a, 0);
  const globalFee = totalVolume * 0.01;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📊 KẾT QUẢ PHÂN TÍCH`);
  console.log(`${'═'.repeat(60)}`);

  // RULE 1: Global Fee
  const feeThreshold = 0.5;
  const feePass = globalFee >= feeThreshold;
  console.log(`\n${feePass ? '✅' : '❌'} GLOBAL FEE: ${globalFee.toFixed(4)} SOL (threshold: ${feeThreshold})`);
  console.log(`   Total volume: ${totalVolume.toFixed(4)} SOL`);

  // RULE 2: Same Buy Amount
  const tolerance = 0.10;
  const groups = [];
  for (const amount of amounts) {
    let found = false;
    for (const group of groups) {
      if (Math.abs(group.avg - amount) / Math.max(group.avg, 0.001) <= tolerance) {
        group.count++;
        group.amounts.push(amount);
        group.avg = (group.avg * (group.count - 1) + amount) / group.count;
        found = true;
        break;
      }
    }
    if (!found) {
      groups.push({ avg: amount, count: 1, amounts: [amount] });
    }
  }
  const largestGroup = groups.reduce((max, g) => g.count > max.count ? g : max, { count: 0 });
  const hasSameAmount = largestGroup.count >= Math.ceil(amounts.length * 0.5);

  console.log(`\n${hasSameAmount ? '✅' : '❌'} SAME BUY AMOUNT:`);
  for (const t of buyerEntries) {
    console.log(`   ${short(t.trader)}: ${t.solAmount.toFixed(4)} SOL`);
  }
  if (hasSameAmount) {
    console.log(`   → Matched: ${largestGroup.count}/${amounts.length} buys ~${largestGroup.avg.toFixed(4)} SOL`);
  }

  // WALLET ANALYSIS
  console.log(`\n--- CHI TIẾT VÍ MUA ---`);
  const walletResults = [];
  for (const t of buyerEntries) {
    console.log(`\nĐang scan ${short(t.trader)}...`);
    const w = await analyzeWallet(t.trader);
    walletResults.push({ ...w, solAmount: t.solAmount });
    console.log(`   ${short(t.trader)} | [${w.label}] | ${w.txCount} txs | ${w.ageDays} ngày | mua ${t.solAmount.toFixed(4)} SOL`);
    if (w.fundingWallets.length > 0) {
      console.log(`   Nguồn tiền: ${w.fundingWallets.map(f => short(f)).join(', ')}`);
    }
    await sleep(500);
  }

  // CLUSTER DETECTION
  console.log(`\n--- CLUSTER & VÍ MẸ ---`);
  const funderCount = {};
  for (const w of walletResults) {
    for (const f of w.fundingWallets) {
      funderCount[f] = (funderCount[f] || 0) + 1;
    }
  }

  const sharedFunders = Object.entries(funderCount).filter(([_, c]) => c >= 2);
  const whiteCount = walletResults.filter(w => w.isWhite).length;
  const ages = walletResults.map(w => w.ageDays);
  const avgAge = ages.length > 0 ? ages.reduce((s, a) => s + a, 0) / ages.length : 0;
  const similarAge = ages.length > 0 && ages.every(a => Math.abs(a - avgAge) < 7);
  const hasCluster = sharedFunders.length > 0 || (similarAge && whiteCount > 1);

  console.log(`\n${hasCluster ? '✅' : '❌'} CLUSTER DETECTION:`);

  if (sharedFunders.length > 0) {
    for (const [addr, count] of sharedFunders) {
      const fDetail = await analyzeFunder(addr);
      await sleep(500);
      console.log(`   → ${short(addr)} [${fDetail.label}] | ${count} ví con | ${fDetail.txCount} txs | ${fDetail.ageDays} ngày`);
    }
  }

  // All funders
  const allFunders = new Set();
  for (const w of walletResults) {
    for (const f of w.fundingWallets) allFunders.add(f);
  }
  if (allFunders.size > 0) {
    console.log(`\n   Tất cả ví mẹ:`);
    for (const addr of allFunders) {
      const fDetail = await analyzeFunder(addr);
      await sleep(400);
      const shared = funderCount[addr] >= 2 ? ` ← CHUNG ${funderCount[addr]} ví con` : '';
      console.log(`   → ${short(addr)} [${fDetail.label}] | ${fDetail.txCount} txs | ${fDetail.ageDays} ngày${shared}`);
    }
  }

  console.log(`\n   Ví mua VÍ TRẮNG: ${whiteCount}/${walletResults.length}`);
  console.log(`   Tuổi ví ±7 ngày: ${similarAge ? 'CÓ' : 'KHÔNG'}`);

  // SUMMARY
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📋 TÓM TẮT`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`1. Global Fee:       ${feePass ? '✅ PASS' : '❌ FAIL'} (${globalFee.toFixed(4)} SOL)`);
  console.log(`2. Same Buy Amount:  ${hasSameAmount ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`3. Cluster/Ví mẹ:   ${hasCluster ? '✅ PASS' : '❌ FAIL'}`);

  const allPass = feePass && hasSameAmount && hasCluster;
  console.log(`\n${allPass
    ? '🟢 THOẢ MÃN → GỬI TELEGRAM'
    : '🔴 KHÔNG THOẢ MÃN → BLOCK'}`);
}

main().catch(console.error);
