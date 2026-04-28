/* ═══════════════════════════════════════════════════════════
   SCAN SOL BOT — sidebar.js
   Passed 24h, Top 10 PnL, Win-rate, Trade history, Wallet, Positions
   ═══════════════════════════════════════════════════════════ */

// ═══════════════════════════════════════
// PASSED TOKENS 24H
// ═══════════════════════════════════════
socket.on('passedTokensUpdate', (tokens) => {
    if (!tokens || tokens.length === 0) {
        passedTokensContainer.innerHTML = '<div class="placeholder-text">Chưa có token qua lọc trong 24h</div>';
        if (totalPassedEl) totalPassedEl.textContent = 0;
        return;
    }

    for (const token of tokens) {
        if (token.mint) countedPasses.add(token.mint);
    }
    if (totalPassedEl) totalPassedEl.textContent = tokens.length;

    unregisterRowsInContainer(passedTokensContainer);
    passedTokensContainer.innerHTML = '';
    for (const token of tokens) {
        const passTime = token.timestamp ? new Date(token.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '---';
        const launchMcap = token.launch_mcap_usd || 1;
        const highMcap = token.highest_mcap_usd || launchMcap;
        const currentMcap = token.current_mcap_usd || 0;

        const peakMultiplier = (highMcap / launchMcap).toFixed(1);
        const peakPnl = ((highMcap - launchMcap) / launchMcap * 100).toFixed(0);

        const currentMultiplier = currentMcap > 0 ? (currentMcap / launchMcap).toFixed(1) : peakMultiplier;
        const currentPnl = currentMcap > 0 ? ((currentMcap - launchMcap) / launchMcap * 100).toFixed(0) : null;

        const row = document.createElement('div');
        row.className = 'passed-row';
        row.dataset.mint = token.mint;
        row.dataset.launch = launchMcap;
        const refreshedAt = token.refreshed_at || token.refreshedAt;
        const refreshAgeMs = refreshedAt ? (Date.now() - new Date(refreshedAt).getTime()) : Infinity;
        const isLive = token.current_mcap_usd > 0 && refreshAgeMs < 600000;
        const isStale = token.current_mcap_usd > 0 && refreshAgeMs >= 600000;
        const statusBadge = isLive
            ? `<span class="mini-badge live" title="Dữ liệu cập nhật ${Math.floor(refreshAgeMs / 60000)}m trước">LIVE</span>`
            : isStale
                ? `<span class="mini-badge" style="background: var(--yellow); color: #000;" title="Dữ liệu cũ — ${Math.floor(refreshAgeMs / 60000)}m trước">CŨ</span>`
                : `<span class="mini-badge token-passed">ĐÃ QUA LỌC</span>`;

        row.innerHTML = `
            <div class="passed-row-header">
                <span class="sym">${token.symbol} <span class="pass-time">${passTime}</span> ${statusBadge}</span>
                <span class="multiplier peak up">x${peakMultiplier}</span>
            </div>
            <div class="mcap-line launch-line">
                <span class="label">MC lúc qua lọc:</span>
                <span class="val yellow">$${formatNumber(launchMcap)} ${token.launch_mcap_sol ? `(${token.launch_mcap_sol.toFixed(2)} SOL)` : ''}</span>
            </div>
            <div class="mcap-line peak-line">
                <span class="label"><span class="term-en" data-tooltip="All-Time High — Mức giá trị thị trường cao nhất đạt được">ATH</span> MC:</span>
                <span class="val up">$${formatNumber(highMcap)} (+${peakPnl}%)</span>
            </div>
            ${currentMcap > 0 ? `
            <div class="mcap-line current-line">
                <span class="label">Hiện tại:</span>
                <span class="val ${currentPnl >= 0 ? 'up' : 'down'}">$${formatNumber(currentMcap)} (${currentPnl >= 0 ? '+' : ''}${currentPnl}%)</span>
            </div>` : ''}
        `;

        row.addEventListener('click', () => {
            requestPassedTokenInfo(token);
        });

        registerTokenRow(token.mint, row);
        passedTokensContainer.appendChild(row);
    }
});

// ═══════════════════════════════════════
// TOP 10 PNL 24H
// ═══════════════════════════════════════
socket.on('topPnLUpdate', (tokens) => {
    if (!tokens || tokens.length === 0) {
        if (top10Container) top10Container.innerHTML = '<div class="placeholder-text">Chưa đủ dữ liệu để tính Top 10</div>';
        return;
    }

    unregisterRowsInContainer(top10Container);
    if (top10Container) top10Container.innerHTML = '';

    tokens.forEach((token, index) => {
        const passTime = token.timestamp ? new Date(token.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '---';
        const launchMcap = token.launch_mcap_usd || 1;
        const highMcap = token.highest_mcap_usd || launchMcap;
        const currentMcap = token.current_mcap_usd || highMcap;

        const peakMultiplier = (highMcap / launchMcap).toFixed(1);
        const peakPnlPercent = ((highMcap - launchMcap) / launchMcap * 100);
        const currentPnlPercent = ((currentMcap - launchMcap) / launchMcap * 100);

        let medalHtml = `<span class="rank-badge">${index + 1}</span>`;
        if (index === 0) medalHtml = `<span class="rank-badge gold"><i class="fas fa-medal"></i> 1</span>`;
        if (index === 1) medalHtml = `<span class="rank-badge silver"><i class="fas fa-medal"></i> 2</span>`;
        if (index === 2) medalHtml = `<span class="rank-badge bronze"><i class="fas fa-medal"></i> 3</span>`;

        const row = document.createElement('div');
        row.className = 'top10-row passed-row';
        row.dataset.mint = token.mint;
        row.dataset.launch = launchMcap;
        row.innerHTML = `
            <div class="passed-row-header top10-header">
                <div class="sym-rank">
                    ${medalHtml}
                    <span class="sym">${token.symbol}</span>
                </div>
                <div style="text-align: right">
                    <div class="multiplier highlight-pnl peak up">+${peakPnlPercent.toFixed(1)}%</div>
                    <div class="highlight-pnl current ${currentPnlPercent >= 0 ? 'up' : 'down'}" style="font-size: 9px; margin-top: 2px;">Hiện: ${currentPnlPercent >= 0 ? '+' : ''}${currentPnlPercent.toFixed(0)}%</div>
                </div>
            </div>
            <div class="mcap-line peak-line">
                <span class="label"><span class="term-en" data-tooltip="All-Time High — Mức giá trị thị trường cao nhất đạt được">ATH</span> MC:</span>
                <span class="val green">$${formatNumber(highMcap)} (x${peakMultiplier})</span>
            </div>
        `;

        row.addEventListener('click', () => {
            requestPassedTokenInfo(token);
        });

        registerTokenRow(token.mint, row);
        top10Container.appendChild(row);
    });
});

// ═══════════════════════════════════════
// WIN RATE 1D / 3D / 7D / ALL
// ═══════════════════════════════════════
socket.on('winRateUpdate', (data) => {
    if (!data) return;
    const periods = ['1d', '3d', '7d', 'all'];
    for (const p of periods) {
        const el = document.getElementById(`winrate${p}`);
        if (!el || !data[p]) continue;
        const { winRate, wins, losses, total, avgPnlPercent } = data[p];
        const strong = el.querySelector('strong');
        if (strong) strong.textContent = total > 0 ? `${winRate.toFixed(1)}%` : '--%';
        el.title = `Tỉ lệ thắng ${p.toUpperCase()}: ${wins} thắng / ${losses} thua (tổng ${total}) | PnL TB (ATH): ${avgPnlPercent.toFixed(1)}% | ≥x1.1 = Thắng, ≤x1.0 = Thua`;
        el.classList.remove('win-high', 'win-mid', 'win-low');
        if (total > 0) {
            if (winRate >= 60) el.classList.add('win-high');
            else if (winRate >= 40) el.classList.add('win-mid');
            else el.classList.add('win-low');
        }
    }
});

// ═══════════════════════════════════════
// TRADE HISTORY
// ═══════════════════════════════════════
socket.on('tradeHistory', (trades) => {
    if (!trades || trades.length === 0) {
        tradeHistoryContainer.innerHTML = '<div class="placeholder-text">Chưa có lệnh nào</div>';
        return;
    }

    unregisterRowsInContainer(tradeHistoryContainer);
    tradeHistoryContainer.innerHTML = '';
    for (const trade of trades) {
        const isBuy = trade.action === 'BUY';
        const time = new Date(trade.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        const pnl = trade.pnl_percent || 0;
        const txSig = trade.tx_signature || trade.signature || '';
        const txLink = txSig ? `<a href="https://solscan.io/tx/${encodeURIComponent(txSig)}" target="_blank" rel="noreferrer" style="color: var(--text-muted); font-size: 9px; text-decoration: none;" title="Xem TX trên Solscan"><i class="fas fa-external-link-alt" style="font-size: 8px;"></i></a>` : '';
        const sellReason = !isBuy && trade.sell_reason ? `<div style="font-size: 9px; color: var(--text-muted);">${escapeHtml(trade.sell_reason)}</div>` : '';
        const mcapAtTrade = trade.market_cap_sol || trade.marketCapSol;
        const mcapStr = mcapAtTrade ? `<span style="font-size: 9px; color: var(--text-muted);">MC: ${mcapAtTrade.toFixed(1)}</span>` : '';

        const row = document.createElement('div');
        row.className = 'trade-row';
        row.dataset.mint = trade.mint;
        row.innerHTML = `
            <div class="trade-icon ${isBuy ? 'buy' : 'sell'}">${isBuy ? 'B' : 'S'}</div>
            <div class="trade-info">
                <div class="sym">${trade.token_symbol || shortenMint(trade.mint)} ${txLink}</div>
                <div class="time">${time} ${mcapStr}</div>
                ${sellReason}
            </div>
            <div class="trade-amount">
                <div class="sol">${trade.sol_amount?.toFixed(3) || '0'} SOL</div>
                ${!isBuy && pnl !== 0 ? `<div class="pnl ${pnl > 0 ? 'green' : 'red'}">${pnl > 0 ? '+' : ''}${pnl.toFixed(1)}%</div>` : ''}
            </div>
        `;
        row.addEventListener('click', () => {
            if (trade.mint) {
                requestAnalysisForMint(trade.mint, {
                    tokenSymbol: trade.token_symbol,
                });
            }
        });
        registerTokenRow(trade.mint, row);
        tradeHistoryContainer.appendChild(row);
    }
});

// ═══════════════════════════════════════
// REAL WALLET & POSITIONS
// ═══════════════════════════════════════
socket.on('realWalletUpdate', (wallet) => {
    updateRealWallet(wallet);
});

socket.on('realPositionsUpdate', (positions) => {
    updateRealPositions(positions);
});

function updateRealWallet(wallet) {
    if (!wallet) return;
    const balanceEl = $('#walletBalanceDisplay');
    const addressEl = $('#walletAddressDisplay');

    if (balanceEl) {
        balanceEl.textContent = `${(wallet.balance || 0).toFixed(4)} SOL`;
    }

    if (addressEl) {
        addressEl.textContent = wallet.address;
        addressEl.title = wallet.address;
    }
}

function updateRealPositions(positions) {
    const container = $('#positionsContainer');
    if (!container) return;

    if (!positions || positions.length === 0) {
        container.innerHTML = '<div class="placeholder-text">Chưa cầm Token nào trong tay</div>';
        return;
    }

    unregisterRowsInContainer(container);
    container.innerHTML = '';
    positions.forEach((pos) => {
        const row = document.createElement('div');
        const pnl = pos.currentPnlPercent || 0;
        row.className = 'trade-row position-row';
        row.dataset.mint = pos.mint;

        const entryTime = pos.entryTimestamp ? new Date(pos.entryTimestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
        const entryReason = pos.entryReason || pos.reason || '';
        const rulesPassedCount = pos.rulesPassedCount || pos.rulesPassed || '';
        const entryDetail = entryReason
            ? `<div style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">${escapeHtml(entryReason)}</div>`
            : (rulesPassedCount ? `<div style="font-size: 9px; color: var(--text-muted); margin-top: 2px;">${rulesPassedCount} rules đạt</div>` : '');

        const currentMcap = pos.currentMarketCapSol || 0;
        const mcapChange = pos.entryMarketCapSol > 0 && currentMcap > 0
            ? ((currentMcap - pos.entryMarketCapSol) / pos.entryMarketCapSol * 100)
            : null;

        row.innerHTML = `
            <div class="trade-icon buy">R</div>
            <div class="trade-info">
                <div class="sym">${pos.symbol || shortenMint(pos.mint)}${entryTime ? ` <span style="font-size: 9px; color: var(--text-muted);">${entryTime}</span>` : ''}</div>
                <div class="time">MC Vào: ${(pos.entryMarketCapSol || 0).toFixed(2)} SOL${currentMcap > 0 ? ` → ${currentMcap.toFixed(2)} SOL` : ''}</div>
                ${entryDetail}
            </div>
            <div class="trade-amount">
                <div class="sol">${(pos.buyAmountSol || 0).toFixed(3)} SOL</div>
                <div class="pnl ${pnl >= 0 ? 'green' : 'red'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%</div>
                ${mcapChange !== null ? `<div style="font-size: 9px; color: ${mcapChange >= 0 ? 'var(--green)' : 'var(--red)'};">MC ${mcapChange >= 0 ? '+' : ''}${mcapChange.toFixed(0)}%</div>` : ''}
            </div>
        `;

        row.addEventListener('click', () => {
            requestAnalysisForMint(pos.mint, {
                tokenSymbol: pos.tokenSymbol,
            });
        });

        registerTokenRow(pos.mint, row);
        container.appendChild(row);
    });
}
