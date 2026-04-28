/* ═══════════════════════════════════════════════════════════
   SCAN SOL BOT — feed.js
   Token feed, filter tabs, search bar, placeholder states
   ═══════════════════════════════════════════════════════════ */

function renderAnalysisPlaceholder(kind, { title, message, mint }) {
    if (!liveAnalysis) return;
    liveAnalysis.dataset.launchMcapUsd = '';
    liveAnalysis.dataset.analysisMint = mint || '';
    const iconMap = {
        loading: '<i class="fas fa-spinner fa-spin"></i>',
        error: '<i class="fas fa-exclamation-triangle"></i>',
        empty: '<i class="fas fa-crosshairs"></i>',
    };
    const mintLine = mint
        ? `<p class="empty-hint" title="${escapeHtml(mint)}">${escapeHtml(mint.slice(0, 8))}…${escapeHtml(mint.slice(-6))}</p>`
        : '';
    liveAnalysis.innerHTML = `
        <div class="empty-state state-${kind}">
            <div class="empty-icon">${iconMap[kind] || iconMap.empty}</div>
            ${title ? `<p class="empty-title">${escapeHtml(title)}</p>` : ''}
            ${message ? `<p>${escapeHtml(message)}</p>` : ''}
            ${mintLine}
        </div>
    `;
}

function clearSearchTimeout() {
    if (_searchTimeoutId) {
        clearTimeout(_searchTimeoutId);
        _searchTimeoutId = null;
    }
}

/**
 * Yêu cầu phân tích cho một mint (dùng chung cho click feed + search).
 * Hiện loading ngay, set timeout 20s, và đánh dấu mint đang chờ để các listener
 * `analysisLoading` / `analysisError` / `analysisResult` biết đây là yêu cầu chủ động.
 */
function requestAnalysisForMint(mint, { tokenName = '', tokenSymbol = '', loadingMessage } = {}) {
    if (!mint) return;
    selectedMint = mint;
    _searchActiveMint = mint;

    const symbol = tokenSymbol || '???';
    const message = loadingMessage
        || (tokenName ? `Đang lấy dữ liệu cho ${symbol} — ${tokenName}…` : 'Đang tra cứu dữ liệu on-chain + DexScreener…');

    renderAnalysisPlaceholder('loading', {
        title: `Đang phân tích ${symbol}`,
        message,
        mint,
    });

    socket.emit('getAnalysis', mint);

    clearSearchTimeout();
    _searchTimeoutId = setTimeout(() => {
        if (_searchActiveMint === mint) {
            renderAnalysisPlaceholder('error', {
                title: 'Không có phản hồi',
                message: 'Máy chủ không trả dữ liệu sau 20 giây. Thử nhấn "Cập nhật trạng thái" hoặc kiểm tra token trên DexScreener.',
                mint,
            });
            _searchActiveMint = null;
        }
    }, SEARCH_TIMEOUT_MS);
}

// ═══════════════════════════════════════
// TOKEN FEED
// ═══════════════════════════════════════
function createFeedItem(token) {
    const item = document.createElement('div');
    item.className = 'feed-item';
    item.dataset.mint = token.mint;
    item.dataset.status = 'pending';
    item.dataset.timestamp = token.timestamp || Date.now();

    let statusClass = 'pending';
    let statusText = 'ĐANG XỬ LÝ';
    if (token.status === 'ELIGIBLE' || token.status === 'PASS') {
        statusClass = 'pass';
        statusText = 'ĐẠT';
        item.dataset.status = 'pass';
    } else if (token.status === 'BLOCKED' || token.status === 'FAIL') {
        statusClass = 'fail';
        statusText = 'LOẠI';
        item.dataset.status = 'fail';
    }

    const symbol = escapeHtml(token.symbol || '???');
    const tokenName = token.name ? escapeHtml(token.name.slice(0, 20)) : '';
    const mint = escapeHtml(token.mint || '');

    item.innerHTML = `
        <div class="feed-item-row">
            <span class="symbol">${symbol}<span class="name-dim">${tokenName ? ` / ${tokenName}` : ''}</span></span>
            <div class="status-container">
                <span class="feed-badge ${statusClass}">${statusText}</span>
                <span class="block-reason"></span>
            </div>
        </div>
        <div class="meta-row">
            <span class="mint-short">${shortenMint(mint)}</span>
            <span class="age-tag" data-ts="${token.timestamp || Date.now()}">${getAge(token.timestamp || Date.now())}</span>
        </div>
    `;

    item.addEventListener('click', () => {
        $$('.feed-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        requestAnalysisForMint(token.mint, {
            tokenSymbol: token.symbol,
            tokenName: token.name,
        });
    });

    return item;
}

function addTokenToFeed(token) {
    if (feedItems.has(token.mint)) return;

    const item = createFeedItem(token);
    feedItems.set(token.mint, item);

    const placeholder = tokenFeed.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    tokenFeed.prepend(item);
    feedCount++;
    feedCounter.textContent = feedCount;

    applyFilter();

    if (feedItems.size > 1000) {
        const keys = [...feedItems.keys()];
        const oldest = keys[0];
        const oldEl = feedItems.get(oldest);
        if (oldEl) oldEl.remove();
        feedItems.delete(oldest);
    }
}

function updateFeedItemStatus(mint, status, ruleResult = null, retryCount = 0, isFinal = false) {
    const item = feedItems.get(mint);
    if (!item) return;

    const badge = item.querySelector('.feed-badge');
    if (!badge) return;

    item.dataset.status = status === 'ELIGIBLE' ? 'pass' : 'fail';

    if (status === 'ELIGIBLE') {
        badge.className = 'feed-badge pass';
        badge.textContent = 'ĐẠT';
        if (!countedPasses.has(mint)) {
            countedPasses.add(mint);
            const current = parseInt(totalPassedEl.textContent) || 0;
            totalPassedEl.textContent = current + 1;
        }
    } else {
        badge.className = 'feed-badge fail';
        badge.textContent = 'LOẠI';

        const reasonEl = item.querySelector('.block-reason');
        if (reasonEl) {
            let note = '';
            if (ruleResult?.blockReasons?.length > 0) {
                note = `Chưa đạt ${ruleResult.blockReasons.length} đ/k`;
            } else if (ruleResult?.summary && ruleResult.summary.includes('Không đủ')) {
                note = 'Thiếu ví mua';
            }

            const currentRetry = retryCount || ruleResult?.retryCount || 0;
            if (currentRetry > 0) {
                note += (note ? ' | ' : '') + `Lần ${currentRetry}`;
            }

            const currentIsFinal = isFinal || ruleResult?.isFinal;
            if (currentIsFinal) {
                note += ' ⏹️';
                item.classList.add('is-final');
            } else {
                item.classList.remove('is-final');
            }

            if (note) {
                reasonEl.textContent = note;
                reasonEl.style.display = 'block';
            } else {
                reasonEl.textContent = '';
                reasonEl.style.display = 'none';
            }
        }
    }

    applyFilter();
}

function applyFilter() {
    feedItems.forEach((el) => {
        const status = el.dataset.status;
        if (currentFilter === 'all') {
            el.classList.remove('hidden-by-filter');
        } else if (currentFilter === status) {
            el.classList.remove('hidden-by-filter');
        } else {
            el.classList.add('hidden-by-filter');
        }
    });
}

socket.on('initialFeed', (tokens) => {
    if (!tokens || tokens.length === 0) return;
    tokenFeed.innerHTML = '';
    feedItems.clear();
    feedCount = 0;

    const sorted = [...tokens].reverse();
    for (const token of sorted) {
        addTokenToFeed(token);
    }
});

socket.on('newToken', (token) => {
    addTokenToFeed(token);
});

// Fast signal — server emit khi token mới có buyer #1 và critical rules pass
// (mint_renounce, transfer_fee, dev_risk, launch_mcap_ceiling, market_cap_check).
// Hiển thị badge ⚡ FAST trên feed item + inline notice trên analysis panel nếu đang xem.
socket.on('fastSignal', (data) => {
    const mint = data?.tokenData?.mint;
    if (!mint) return;

    const item = feedItems.get(mint);
    if (item && !item.querySelector('.feed-fast-badge')) {
        const symbolEl = item.querySelector('.symbol');
        if (symbolEl) {
            const fast = document.createElement('span');
            fast.className = 'feed-fast-badge';
            fast.title = data.note || 'Critical rules pass tại buyer #1 — chờ full analysis confirm';
            fast.textContent = '⚡ FAST';
            fast.style.cssText = 'margin-left:6px;padding:1px 6px;border-radius:4px;background:rgba(255,200,0,0.2);color:#ffc800;font-size:9px;font-weight:700;letter-spacing:0.5px';
            symbolEl.appendChild(fast);
        }
    }

    // Nếu user đang xem token này trong analysis panel, show một notice nhỏ
    if (selectedMint === mint && liveAnalysis) {
        let notice = liveAnalysis.querySelector('.fast-signal-notice');
        if (!notice) {
            notice = document.createElement('div');
            notice.className = 'fast-signal-notice';
            notice.style.cssText = 'background:rgba(255,200,0,0.1);border:1px solid rgba(255,200,0,0.4);border-radius:8px;padding:10px 14px;margin:12px 0;color:#ffc800;font-size:12px;font-weight:600;display:flex;align-items:center;gap:8px';
            const card = liveAnalysis.querySelector('.detail-card.analysis-report');
            if (card) {
                card.insertBefore(notice, card.firstChild);
            } else {
                liveAnalysis.prepend(notice);
            }
        }
        const sym = data.tokenData?.symbol || '???';
        const passedCount = (data.fastResults || []).filter(r => r.passed).length;
        notice.innerHTML = `⚡ <span>Tín hiệu nhanh: <strong>${escapeHtml(sym)}</strong> đã pass ${passedCount} critical rules tại buyer #${data.buyerCount || 1}. Phân tích đầy đủ đang chạy…</span>`;
    }
});

socket.on('tokenPriceUpdate', (data) => {
    const { mint, marketCapSol, marketCapUsd, globalFee } = data;
    const priceUsd = parseFloat(document.getElementById('solPrice')?.textContent?.replace('$', '') || 150);
    const currentMcapUsd = marketCapUsd || (marketCapSol * priceUsd);

    if (selectedMint === mint) {
        const launchMcapUsd = parseFloat(liveAnalysis?.dataset?.launchMcapUsd) || 0;
        const currentMcVal = document.getElementById('analysisCurrentMcapUsd');
        const currentMcSol = document.getElementById('analysisCurrentMcapSol');
        const currentRoi = document.getElementById('analysisCurrentRoi');
        const currentPnl = document.getElementById('analysisCurrentPnl');
        const refreshMeta = document.getElementById('analysisRefreshMeta');
        const feeVal = document.getElementById('analysisGlobalFee');
        const currentCard = currentMcVal?.closest('.snapshot-card');

        if (currentMcVal) currentMcVal.textContent = '$' + formatNumber(currentMcapUsd);
        if (currentMcSol) {
            const currentSol = marketCapSol || (priceUsd > 0 ? currentMcapUsd / priceUsd : 0);
            currentMcSol.textContent = currentSol > 0 ? `${currentSol.toFixed(2)} SOL` : '---';
        }
        if (feeVal && Number.isFinite(globalFee)) feeVal.textContent = `${globalFee.toFixed(4)} SOL`;
        if (refreshMeta) refreshMeta.textContent = 'vừa cập nhật';

        if (launchMcapUsd > 0 && currentMcapUsd > 0) {
            const roiValue = currentMcapUsd / launchMcapUsd;
            const pnlValue = ((currentMcapUsd - launchMcapUsd) / launchMcapUsd) * 100;
            const tone = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'neutral';

            if (currentRoi) {
                currentRoi.textContent = `x${roiValue.toFixed(2)}`;
                currentRoi.className = tone;
            }
            if (currentPnl) {
                currentPnl.textContent = `${pnlValue >= 0 ? '+' : ''}${pnlValue.toFixed(1)}%`;
                currentPnl.className = tone;
            }
            if (currentCard) {
                currentCard.classList.remove('positive', 'negative', 'neutral');
                currentCard.classList.add(tone);
            }
        }
    }

    const rows = document.querySelectorAll(`[data-mint="${mint}"]`);
    rows.forEach(row => {
        const launchMcap = parseFloat(row.dataset.launch) || 0;
        if (launchMcap > 0) {
            const currentMultiplier = (currentMcapUsd / launchMcap).toFixed(1);
            const currentPnl = ((currentMcapUsd - launchMcap) / launchMcap * 100).toFixed(0);

            const multSpan = row.querySelector('.multiplier.current');
            if (multSpan) multSpan.textContent = 'x' + currentMultiplier;

            const currentValSpan = row.querySelector('.mcap-line.current-line .val');
            if (currentValSpan) {
                currentValSpan.textContent = `$${formatNumber(currentMcapUsd)} (${currentPnl >= 0 ? '+' : ''}${currentPnl}%)`;
                currentValSpan.className = `val ${currentPnl >= 0 ? 'up' : 'down'}`;
            }

            const highlightPnl = row.querySelector('.highlight-pnl.current');
            if (highlightPnl) {
                highlightPnl.textContent = `Hiện: ${currentPnl >= 0 ? '+' : ''}${currentPnl}%`;
                highlightPnl.className = `highlight-pnl current ${currentPnl >= 0 ? 'up' : 'down'}`;
            }
        }
    });
});

// ═══════════════════════════════════════
// FEED FILTER
// ═══════════════════════════════════════
$$('.feed-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
        $$('.feed-tabs .tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentFilter = tab.dataset.filter;
        applyFilter();
    });
});

// ═══════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════
function handleSearch() {
    const mint = contractSearch.value.trim();
    if (!mint) return;

    if (!MINT_REGEX.test(mint)) {
        renderAnalysisPlaceholder('error', {
            title: 'Địa chỉ không hợp lệ',
            message: 'Mint phải là chuỗi base58 dài 32–44 ký tự.',
            mint,
        });
        return;
    }

    requestAnalysisForMint(mint, {
        loadingMessage: 'Đang tra cứu dữ liệu on-chain + DexScreener…',
    });
}

function requestPassedTokenInfo(tokenOrMint) {
    const mint = typeof tokenOrMint === 'string' ? tokenOrMint : tokenOrMint?.mint;
    if (!mint) return;

    selectedMint = mint;

    if (typeof tokenOrMint === 'object') {
        const launchMcapUsd = tokenOrMint.launch_mcap_usd || 0;
        const highestMcapUsd = tokenOrMint.highest_mcap_usd || launchMcapUsd;
        const currentMcapUsd = tokenOrMint.current_mcap_usd || highestMcapUsd;
        const launchMcapSol = tokenOrMint.launch_mcap_sol || 0;
        const highestMcapSol = tokenOrMint.highest_mcap_sol || launchMcapSol;
        const currentMcapSol = tokenOrMint.current_mcap_sol || highestMcapSol || launchMcapSol;

        renderAnalysis({
            infoOnly: true,
            tokenData: {
                mint,
                name: tokenOrMint.name || 'Không rõ',
                symbol: tokenOrMint.symbol || '???',
                deployer: tokenOrMint.deployer || '',
                timestamp: tokenOrMint.timestamp || Date.now(),
                launchMcapUsd,
                launchMcapSol,
                highestMcapUsd,
                highestMcapSol,
                highestMcapTimestamp: tokenOrMint.highest_mcap_timestamp || null,
                currentMcapUsd,
                currentMcapSol,
                marketCapUsd: currentMcapUsd || highestMcapUsd,
                circulatingMcapUsd: currentMcapUsd || highestMcapUsd,
                refreshedAt: tokenOrMint.refreshed_at || tokenOrMint.refreshedAt || null,
            },
            ruleResult: {
                shouldBuy: true,
                summary: 'Thông tin token đã qua lọc',
                results: []
            }
        });
    }

    socket.emit('getAnalysis', { mint, mode: 'passed-info' });
}

searchBtn?.addEventListener('click', handleSearch);
contractSearch?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSearch();
});
