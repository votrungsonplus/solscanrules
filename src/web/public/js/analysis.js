/* ═══════════════════════════════════════════════════════════
   SCAN SOL BOT — analysis.js
   Analysis detail panel, renderAnalysis, manual refresh
   ═══════════════════════════════════════════════════════════ */

// ═══════════════════════════════════════
// MANUAL REFRESH (exposed to window for inline onclick)
// ═══════════════════════════════════════
function manualRefresh(mint) {
    const btn = $('#refreshBtn');
    if (!btn) return;

    btn.disabled = true;
    const icon = btn.querySelector('i');
    if (icon) icon.classList.add('spinning');
    btn.querySelector('span').textContent = 'Đang làm mới...';

    socket.emit('manualRefresh', mint);

    setTimeout(() => {
        if (btn.disabled) {
            btn.disabled = false;
            if (icon) icon.classList.remove('spinning');
            btn.querySelector('span').textContent = 'Cập nhật trạng thái';
        }
    }, 10000);
}

function refreshPassedTokenInfo(mint) {
    const btn = $('#refreshPassedInfoBtn');
    if (!mint || !btn) return;

    selectedMint = mint;

    btn.disabled = true;
    const icon = btn.querySelector('i');
    if (icon) icon.classList.add('spinning');
    const label = btn.querySelector('span');
    if (label) label.textContent = 'Đang cập nhật...';

    socket.emit('refreshPassedTokenInfo', mint);
}

// ── PnL Refresh ──
refreshPassedBtn?.addEventListener('click', () => {
    const icon = refreshPassedBtn.querySelector('i');
    if (icon) icon.classList.add('fa-spin');
    refreshPassedBtn.disabled = true;

    socket.emit('refreshAllPnL');
});

socket.on('refreshPnLStatus', (data) => {
    const icon = refreshPassedBtn?.querySelector('i');
    const statusMsg = document.getElementById('refreshStatusMsg');

    if (icon) icon.classList.remove('fa-spin');
    if (refreshPassedBtn) refreshPassedBtn.disabled = false;

    if (statusMsg) {
        statusMsg.textContent = data.message;
        statusMsg.className = `refresh-status-msg ${data.success ? 'success' : 'error'}`;
        statusMsg.style.opacity = '1';

        setTimeout(() => {
            statusMsg.style.opacity = '0';
        }, 3000);
    }

    if (!data.success) {
        console.error('Lam moi PnL that bai:', data.message);
    }
});

socket.on('refreshPassedTokenInfoStatus', (data) => {
    const btn = $('#refreshPassedInfoBtn');
    if (!btn) return;

    btn.disabled = false;
    const icon = btn.querySelector('i');
    if (icon) icon.classList.remove('spinning');
    const label = btn.querySelector('span');
    if (label) label.textContent = 'Cập nhật trạng thái';

    if (!data.success) {
        alert('Cập nhật thất bại: ' + data.message);
    }
});

// ═══════════════════════════════════════
// ANALYSIS DETAIL EVENTS
// ═══════════════════════════════════════
socket.on('analysisLoading', (data) => {
    if (!data?.mint || data.mint !== _searchActiveMint) return;
    renderAnalysisPlaceholder('loading', {
        title: 'Đang phân tích token',
        message: data.message || 'Đang tra cứu dữ liệu on-chain…',
        mint: data.mint,
    });
});

socket.on('analysisError', (data) => {
    if (!data?.mint || data.mint !== _searchActiveMint) return;
    clearSearchTimeout();
    _searchActiveMint = null;
    renderAnalysisPlaceholder('error', {
        title: 'Không tìm thấy token',
        message: data.message || 'Không có dữ liệu phản hồi.',
        mint: data.mint,
    });
});

socket.on('analysisResult', (data) => {
    const { tokenData, ruleResult } = data;

    if (tokenData?.mint && tokenData.mint === _searchActiveMint) {
        clearSearchTimeout();
        _searchActiveMint = null;
    }

    if (tokenData?.mint && ruleResult) {
        updateFeedItemStatus(tokenData.mint, ruleResult.shouldBuy ? 'ELIGIBLE' : 'BLOCKED', ruleResult, data.retryCount, data.isFinal);
    }

    if (tokenData?.mint && !analyzedMints.has(tokenData.mint)) {
        analyzedMints.add(tokenData.mint);
        const scanned = parseInt(totalScannedEl.textContent) || 0;
        totalScannedEl.textContent = scanned + 1;
    }

    if (!selectedMint || selectedMint === tokenData?.mint) {
        if (!selectedMint && tokenData?.mint) {
            selectedMint = tokenData.mint;
            const feedItem = feedItems.get(tokenData.mint);
            if (feedItem) {
                $$('.feed-item').forEach(i => i.classList.remove('active'));
                feedItem.classList.add('active');
            }
        }
        renderAnalysis(data);
    }
});

socket.on('initialScans', (scans) => {
    if (!scans || scans.length === 0) return;
    const ordered = Array.isArray(scans) ? [...scans].reverse() : [];
    for (const scan of ordered) {
        if (scan.mint) {
            analyzedMints.add(scan.mint);
            if (scan.action_taken === 'ELIGIBLE') {
                countedPasses.add(scan.mint);
            }
        }
        if (scan.action_taken) {
            updateFeedItemStatus(scan.mint, scan.action_taken, scan._analysisResult?.ruleResult, scan._analysisResult?.retryCount, scan._analysisResult?.isFinal);
        }
    }
    totalPassedEl.textContent = countedPasses.size;

    const latest = scans[0];
    if (latest) {
        try {
            if (latest._analysisResult) {
                renderAnalysis(latest._analysisResult);
            } else {
                const ruleResult = JSON.parse(latest.rule_result);
                renderAnalysis({
                    tokenData: {
                        mint: latest.mint,
                        name: latest.token_name,
                        symbol: latest.token_symbol,
                        deployer: latest.deployer,
                        timestamp: latest.timestamp,
                    },
                    ruleResult,
                    devRiskScore: latest.dev_risk_score,
                    tokenScore: latest.token_score,
                });
            }
        } catch (e) { /* ignore parse errors */ }
    }
});

// ═══════════════════════════════════════
// RENDER HELPERS
// ═══════════════════════════════════════
function safeNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function formatUsdCompact(value) {
    const num = safeNumber(value, 0);
    return num > 0 ? '$' + formatNumber(num) : '---';
}

function formatSolCompact(value, digits = 2) {
    const num = safeNumber(value, 0);
    return num > 0 ? `${num.toFixed(digits)} SOL` : '---';
}

function formatSignedPercent(value, digits = 1) {
    const num = Number(value);
    return Number.isFinite(num)
        ? `${num >= 0 ? '+' : ''}${num.toFixed(digits)}%`
        : '---';
}

function formatMultiplierCompact(value, digits = 2) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0
        ? `x${num.toFixed(digits)}`
        : '---';
}

function formatDateTime(value) {
    return value ? new Date(value).toLocaleString('vi-VN') : '---';
}

function formatRelativeTime(value) {
    if (!value) return '---';
    const deltaMs = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return '---';
    if (deltaMs < 60000) return `${Math.floor(deltaMs / 1000)}s trước`;
    if (deltaMs < 3600000) return `${Math.floor(deltaMs / 60000)}m trước`;
    if (deltaMs < 86400000) return `${Math.floor(deltaMs / 3600000)}h trước`;
    return `${Math.floor(deltaMs / 86400000)}d trước`;
}

function toneClassFromValue(value, { invert = false } = {}) {
    const num = Number(value);
    if (!Number.isFinite(num) || num === 0) return 'neutral';
    const positive = invert ? num < 0 : num > 0;
    return positive ? 'positive' : 'negative';
}

function valueClassFromTone(tone) {
    if (tone === 'positive') return 'green';
    if (tone === 'negative') return 'red';
    if (tone === 'warning') return 'yellow';
    return '';
}

function buildInfoRows(rows = []) {
    return rows
        .filter(Boolean)
        .map((row) => {
            const label = row.label || '---';
            const value = row.html !== undefined ? row.html : escapeHtml(String(row.value ?? '---'));
            const valClass = ['val', row.tone || '', row.className || '', row.allowBreak ? 'allow-break' : '']
                .filter(Boolean)
                .join(' ');

            return `
                <div class="info-row">
                    <span class="label">${label}</span>
                    <span class="${valClass}">${value}</span>
                </div>
            `;
        })
        .join('');
}

function buildSnapshotCard({ title, subtitle = '', value, secondary = '', tone = 'neutral', time = '', metrics = [] }) {
    const metricHtml = metrics.length > 0
        ? `
            <div class="snapshot-stats">
                ${metrics.map((metric) => `
                    <div class="snapshot-stat">
                        <span>${metric.label}</span>
                        <strong class="${metric.tone || ''}" ${metric.id ? `id="${metric.id}"` : ''}>${metric.value}</strong>
                    </div>
                `).join('')}
            </div>
        `
        : '';

    return `
        <div class="snapshot-card ${tone}">
            <div class="snapshot-head">
                <div>
                    <div class="snapshot-title">${title}</div>
                    ${subtitle ? `<div class="snapshot-subtitle">${subtitle}</div>` : ''}
                </div>
                ${time ? `<span class="snapshot-time">${time}</span>` : ''}
            </div>
            <div class="snapshot-main">${value}</div>
            <div class="snapshot-secondary">${secondary || '---'}</div>
            ${metricHtml}
        </div>
    `;
}

function buildMetricCard({ label, value, note = '', tone = '' }) {
    return `
        <div class="market-item">
            <div class="label">${label}</div>
            <div class="value ${tone}">${value}</div>
            ${note ? `<div class="market-note">${note}</div>` : ''}
        </div>
    `;
}

// ═══════════════════════════════════════
// RENDER ANALYSIS (main detail panel)
// ═══════════════════════════════════════
function renderAnalysis(data) {
    const { tokenData, ruleResult, devAnalysis, tokenScore, holderStats, clusterAnalysis, earlyBuyers, earlyBuyerTrades, globalFee } = data;

    if (!tokenData || !ruleResult) return;

    const mint = tokenData.mint || '';
    const safeMint = escapeHtml(mint);
    const symbol = escapeHtml(tokenData.symbol || '???');
    const name = escapeHtml(tokenData.name || '');
    const deployer = escapeHtml(tokenData.deployer || '');
    const isPassed = ruleResult.shouldBuy;
    const infoOnly = data.infoOnly === true;
    const encodedMint = encodeURIComponent(mint);
    const encodedRouteAddress = encodeURIComponent(tokenData.axiomRouteAddress || mint);

    const useSolPrice = solPrice || safeNumber(document.getElementById('solPrice')?.textContent?.replace('$', ''), 150);
    const launchMcapUsd = safeNumber(tokenData.launchMcapUsd, 0);
    const currentMcapUsd = safeNumber(tokenData.currentMcapUsd || tokenData.marketCapUsd || tokenData.circulatingMcapUsd, 0);
    const highestMcapUsd = safeNumber(tokenData.highestMcapUsd || currentMcapUsd || launchMcapUsd, 0);
    const launchMcapSol = safeNumber(tokenData.launchMcapSol || (launchMcapUsd > 0 && useSolPrice > 0 ? launchMcapUsd / useSolPrice : 0), 0);
    const currentMcapSol = safeNumber(tokenData.currentMcapSol || tokenData.marketCapSol || (currentMcapUsd > 0 && useSolPrice > 0 ? currentMcapUsd / useSolPrice : 0), 0);
    const highestMcapSol = safeNumber(tokenData.highestMcapSol || (highestMcapUsd > 0 && useSolPrice > 0 ? highestMcapUsd / useSolPrice : 0), 0);
    const circulatingMcapSol = safeNumber(tokenData.circulatingMcapSol || currentMcapSol || tokenData.marketCapSol, 0);
    const circulatingMcapUsd = safeNumber(tokenData.circulatingMcapUsd || currentMcapUsd || (circulatingMcapSol * useSolPrice), 0);
    const bondingProgress = safeNumber(
        tokenData.bondingCurveProgress || (tokenData.vSolInBondingCurve ? (tokenData.vSolInBondingCurve / 85) * 100 : 0),
        0
    );
    const vSolInCurve = safeNumber(tokenData.vSolInBondingCurve, 0);
    const gFee = safeNumber(globalFee || tokenData.globalFee, 0);
    const volume = safeNumber(tokenData.volume || (gFee * 100), 0);
    const analysisAt = tokenData.analysisTimestamp || null;
    const refreshedAt = tokenData.refreshedAt || null;
    const highestAt = tokenData.highestMcapTimestamp || null;
    const recordedAt = tokenData.timestamp || null;

    const currentPnlPct = launchMcapUsd > 0 && currentMcapUsd > 0
        ? ((currentMcapUsd - launchMcapUsd) / launchMcapUsd) * 100
        : null;
    const peakPnlPct = launchMcapUsd > 0 && highestMcapUsd > 0
        ? ((highestMcapUsd - launchMcapUsd) / launchMcapUsd) * 100
        : null;
    const currentRoi = launchMcapUsd > 0 && currentMcapUsd > 0 ? currentMcapUsd / launchMcapUsd : null;
    const peakRoi = launchMcapUsd > 0 && highestMcapUsd > 0 ? highestMcapUsd / launchMcapUsd : null;

    const currentTone = toneClassFromValue(currentPnlPct);
    const peakTone = toneClassFromValue(peakPnlPct);
    const dataFreshness = analysisAt ? formatRelativeTime(analysisAt) : (refreshedAt ? formatRelativeTime(refreshedAt) : '---');
    const freshnessTone = analysisAt
        ? (Date.now() - new Date(analysisAt).getTime() < 60000
            ? 'green'
            : Date.now() - new Date(analysisAt).getTime() < 300000
                ? 'yellow'
                : 'red')
        : '';
    const refreshAgeMs = refreshedAt ? Date.now() - new Date(refreshedAt).getTime() : Infinity;
    const liveBadge = refreshedAt && currentMcapUsd > 0 && refreshAgeMs < 600000
        ? `<span class="mini-badge live">LIVE</span>`
        : refreshedAt && currentMcapUsd > 0
            ? `<span class="mini-badge stale">DỮ LIỆU CŨ</span>`
            : infoOnly || isPassed
                ? `<span class="mini-badge token-passed">${infoOnly ? 'ĐÃ QUA LỌC' : 'VƯỢT BỘ LỌC'}</span>`
                : '';

    const refreshButtonHtml = infoOnly
        ? `
            <button class="refresh-btn" id="refreshPassedInfoBtn" onclick="refreshPassedTokenInfo('${mint}')">
                <i class="fas fa-rotate"></i>
                <span>Cập nhật trạng thái</span>
            </button>
        `
        : `
            <button class="refresh-btn" id="refreshBtn" onclick="manualRefresh('${mint}')">
                <i class="fas fa-sync-alt"></i>
                <span>Cập nhật trạng thái</span>
            </button>
        `;

    const ruleResults = Array.isArray(ruleResult.results) ? ruleResult.results : [];
    const passedRuleCount = ruleResults.filter((r) => r.passed).length;
    const warningRuleCount = ruleResults.filter((r) => !r.passed && r.ruleType === 'ALERT').length;
    const blockedRuleCount = ruleResults.filter((r) => !r.passed && r.ruleType !== 'ALERT' && r.ruleType !== 'INFO').length;
    const signalRuleCount = ruleResults.filter((r) => r.ruleType === 'INFO').length;

    let html = `<div class="detail-card analysis-report">`;

    html += `
        <div class="analysis-topline">
            <div class="detail-title analysis-title-block">
                <div class="analysis-title-row">
                    <h3>${symbol}</h3>
                    <span class="verdict-badge ${isPassed ? 'pass' : 'fail'}">${isPassed ? 'ĐẠT' : 'LOẠI'}</span>
                    ${liveBadge}
                </div>
                <div class="analysis-name">${name || 'Chưa có tên token'}</div>
                <div class="detail-mint">
                    <span>${safeMint}</span>
                    <button class="copy-btn" onclick="navigator.clipboard.writeText('${mint}')"><i class="fas fa-copy"></i></button>
                </div>
                <div class="analysis-meta-line">
                    <span><i class="fas fa-clock"></i> ${infoOnly ? 'Qua lọc' : 'Ghi nhận'}: ${formatDateTime(recordedAt)}</span>
                    <span><i class="fas fa-wave-square"></i> Snapshot: <span id="analysisRefreshMeta">${refreshedAt ? formatRelativeTime(refreshedAt) : dataFreshness}</span></span>
                    <span><i class="fas fa-user"></i> ${deployer ? shortenMint(deployer) : 'Chưa rõ deployer'}</span>
                </div>
            </div>
            <div class="analysis-side">
                <div class="detail-links">
                    <a href="https://pump.fun/coin/${encodedMint}" target="_blank" rel="noreferrer"><i class="fas fa-rocket"></i> Pump</a>
                    <a href="https://dexscreener.com/solana/${encodedMint}" target="_blank" rel="noreferrer"><i class="fas fa-chart-area"></i> DexS</a>
                    <a href="https://solscan.io/token/${encodedMint}" target="_blank" rel="noreferrer"><i class="fas fa-cube"></i> Solscan</a>
                    <a href="https://trade.padre.gg/trade/solana/${encodedRouteAddress}" target="_blank" rel="noreferrer"><i class="fas fa-fire"></i> Padre</a>
                </div>
                <div class="analysis-actions">
                    ${refreshButtonHtml}
                    <div class="analysis-note">
                        ${infoOnly
                            ? 'Token đã qua lọc. Khi làm mới, hệ thống sẽ cập nhật current MC, PnL và ROI mới nhất.'
                            : 'Báo cáo gồm snapshot thị trường, kết quả rule và chi tiết hành vi on-chain của token này.'}
                    </div>
                </div>
            </div>
        </div>
    `;

    html += `
        <div class="performance-grid">
            ${buildSnapshotCard({
                title: infoOnly || isPassed ? 'Mốc qua lọc' : 'Mốc phân tích',
                subtitle: 'Mốc gốc dùng để tính PnL và ROI',
                value: formatUsdCompact(launchMcapUsd),
                secondary: formatSolCompact(launchMcapSol),
                time: recordedAt ? formatRelativeTime(recordedAt) : '',
                metrics: [
                    { label: 'Vai trò', value: infoOnly || isPassed ? 'Mốc vào' : 'Mốc gốc' },
                    { label: 'Mốc ATH', value: highestAt ? formatRelativeTime(highestAt) : '---' },
                ],
            })}
            ${buildSnapshotCard({
                title: 'Hiện tại',
                subtitle: 'Snapshot market cap mới nhất',
                value: `<span id="analysisCurrentMcapUsd">${formatUsdCompact(currentMcapUsd)}</span>`,
                secondary: `<span id="analysisCurrentMcapSol">${formatSolCompact(currentMcapSol)}</span>`,
                tone: currentTone,
                time: refreshedAt ? formatRelativeTime(refreshedAt) : '',
                metrics: [
                    { label: 'ROI', value: currentRoi !== null ? formatMultiplierCompact(currentRoi) : '---', tone: currentTone, id: 'analysisCurrentRoi' },
                    { label: 'PnL', value: currentPnlPct !== null ? formatSignedPercent(currentPnlPct) : '---', tone: currentTone, id: 'analysisCurrentPnl' },
                ],
            })}
            ${buildSnapshotCard({
                title: renderTerm('ATH', 'ath'),
                subtitle: 'Đỉnh market cap kể từ lúc theo dõi',
                value: formatUsdCompact(highestMcapUsd),
                secondary: formatSolCompact(highestMcapSol),
                tone: peakTone,
                time: highestAt ? formatRelativeTime(highestAt) : '',
                metrics: [
                    { label: 'ROI', value: peakRoi !== null ? formatMultiplierCompact(peakRoi) : '---', tone: peakTone },
                    { label: 'PnL', value: peakPnlPct !== null ? formatSignedPercent(peakPnlPct) : '---', tone: peakTone },
                ],
            })}
        </div>
    `;

    html += `
        <div class="market-data analysis-kpis">
            ${buildMetricCard({
                label: renderTerm('MC', 'mcCirc'),
                value: formatSolCompact(circulatingMcapSol, 1),
                note: circulatingMcapUsd > 0 ? formatUsdCompact(circulatingMcapUsd) : '',
            })}
            ${buildMetricCard({
                label: `${renderTerm('Volume', 'volume')} 24h`,
                value: formatSolCompact(volume, 1),
                note: currentMcapUsd > 0 ? `MC hiện tại ${formatUsdCompact(currentMcapUsd)}` : '',
            })}
            ${buildMetricCard({
                label: renderTerm('Global Fee', 'globalFee'),
                value: `<span id="analysisGlobalFee">${formatSolCompact(gFee, 4)}</span>`,
                note: 'xấp xỉ volume x 1%',
                tone: 'yellow',
            })}
            ${buildMetricCard({
                label: `${renderTerm('Holder', 'holder')} thực`,
                value: holderStats?.realHolderCount !== undefined ? String(holderStats.realHolderCount) : '---',
                note: typeof holderStats?.filteredFunctionalCount === 'number' ? `Lọc bỏ ${holderStats.filteredFunctionalCount} ví hệ thống` : '',
                tone: holderStats?.realHolderCount ? 'green' : '',
            })}
            ${buildMetricCard({
                label: renderTerm('Bonding Curve', 'bondingCurve'),
                value: bondingProgress > 0 ? `${bondingProgress.toFixed(1)}%` : '---',
                note: vSolInCurve > 0 ? `${vSolInCurve.toFixed(1)} SOL trong curve` : 'Có thể đã lên DEX',
                tone: bondingProgress >= 70 ? 'yellow' : '',
            })}
            ${buildMetricCard({
                label: renderTerm('Token Score', 'tokenScore'),
                value: tokenScore && typeof tokenScore === 'object' && tokenScore.totalScore !== undefined
                    ? `${tokenScore.totalScore}/100`
                    : (typeof data.tokenScore === 'number' ? `${data.tokenScore}/100` : '---'),
                note: tokenScore && typeof tokenScore === 'object' && tokenScore.verdict
                    ? escapeHtml(tokenScore.verdict)
                    : 'Đánh giá chất lượng token',
                tone: tokenScore && typeof tokenScore === 'object'
                    ? valueClassFromTone(tokenScore.totalScore >= 70 ? 'positive' : tokenScore.totalScore >= 45 ? 'warning' : 'negative')
                    : '',
            })}
        </div>
    `;

    html += `
        <div class="progress-section">
            <div class="progress-bar-container">
                <div class="progress-label">
                    <span>${renderTerm('Bonding Curve', 'bondingCurve')}</span>
                    <span>${bondingProgress > 0 ? `${bondingProgress.toFixed(1)}%` : 'Không có dữ liệu'}${vSolInCurve > 0 ? ` — ${vSolInCurve.toFixed(1)} SOL` : ''}</span>
                </div>
                ${bondingProgress > 0
                    ? `
                        <div class="progress-bar">
                            <div class="progress-fill ${bondingProgress > 70 ? 'high' : ''}" style="width: ${Math.min(bondingProgress, 100)}%"></div>
                        </div>
                    `
                    : '<div class="progress-placeholder">Có thể token đã lên DEX hoặc chưa lấy được snapshot bonding curve.</div>'}
            </div>
        </div>
    `;

    html += `
        <div class="verdict-box ${isPassed ? 'pass' : 'fail'}">
            <i class="fas ${isPassed ? 'fa-check-double' : 'fa-shield-alt'}"></i>
            <div class="verdict-copy">
                <strong>${infoOnly ? 'Trạng thái token đã qua lọc' : (isPassed ? 'Token đạt bộ quy tắc' : 'Token bị chặn bởi bộ quy tắc')}</strong>
                <span>${formatRichText(ruleResult.summary || (isPassed ? 'Tất cả quy tắc đều đạt.' : 'Bị chặn bởi bộ quy tắc.'))}</span>
            </div>
        </div>
    `;

    if (ruleResults.length > 0) {
        html += `
            <div class="section-title"><i class="fas fa-list-check"></i> Kết quả bộ quy tắc</div>
            <div class="summary-chip-grid">
                <div class="summary-chip positive">
                    <span>Đạt</span>
                    <strong>${passedRuleCount}/${ruleResults.length}</strong>
                </div>
                <div class="summary-chip ${warningRuleCount > 0 ? 'warning' : ''}">
                    <span>Cảnh báo</span>
                    <strong>${warningRuleCount}</strong>
                </div>
                <div class="summary-chip ${blockedRuleCount > 0 ? 'negative' : ''}">
                    <span>Chặn</span>
                    <strong>${blockedRuleCount}</strong>
                </div>
                <div class="summary-chip ${signalRuleCount > 0 ? 'brand' : ''}">
                    <span>Tín hiệu</span>
                    <strong>${signalRuleCount}</strong>
                </div>
            </div>
            <div class="rules-grid">
        `;

        for (const r of ruleResults) {
            const cls = r.passed ? 'pass' : (r.ruleType === 'INFO' ? 'info' : 'fail');
            const icon = r.passed ? 'fa-check-circle' : (r.ruleType === 'INFO' ? 'fa-info-circle' : 'fa-times-circle');
            html += `
                <div class="rule-row ${cls}">
                    <i class="fas ${icon} rule-icon"></i>
                    <div class="rule-body">
                        <div class="rule-name">
                            ${getRuleDisplayName(r.ruleId, r.ruleName)}
                            <span class="rule-type-badge ${String(r.ruleType || '').toLowerCase()}">${getRuleTypeLabel(r.ruleType)}</span>
                        </div>
                        <div class="rule-reason">${formatRichText(r.reason)}</div>
                    </div>
                </div>
            `;
        }
        html += `</div>`;
    } else if (ruleResult.isLegacy) {
        html += `
            <div class="legacy-note">
                <div class="legacy-note-body">${formatRichText(ruleResult.summary)}</div>
                <div class="legacy-note-foot">(Bản ghi cũ - chưa có dữ liệu quy tắc chi tiết)</div>
            </div>
        `;
    }

    const devData = devAnalysis || {};
    const tsData = (typeof tokenScore === 'object') ? tokenScore : {};
    const hasIntelSection = Boolean(
        devData.address
        || tsData.totalScore !== undefined
        || data.devRiskScore !== undefined
        || holderStats
        || clusterAnalysis
        || recordedAt
    );

    if (hasIntelSection) {
        html += `<div class="section-title"><i class="fas fa-microscope"></i> Chi tiết phân tích on-chain</div>`;
        html += `<div class="analysis-intel-grid">`;

        const devRiskValue = devData.riskScore !== undefined ? safeNumber(devData.riskScore, 0) : safeNumber(data.devRiskScore, 0);
        const devRiskTone = devRiskValue >= 70 ? 'red' : devRiskValue >= 40 ? 'yellow' : 'green';
        const devRiskLabel = escapeHtml(devData.riskLevel || '---');
        const devSolscan = devData.address ? `https://solscan.io/account/${encodeURIComponent(devData.address)}` : '';

        html += `
            <div class="info-card">
                <h4><i class="fas fa-user-shield"></i> Phân tích ${renderTerm('Dev', 'dev')}</h4>
                ${buildInfoRows([
                    devData.address ? {
                        label: 'Địa chỉ',
                        html: `<a href="${devSolscan}" target="_blank" rel="noreferrer" class="mono-link" title="${escapeHtml(devData.address)}">${escapeHtml(devData.address)}</a>`,
                        allowBreak: true,
                    } : null,
                    (devData.address || data.devRiskScore !== undefined) ? {
                        label: renderTerm('Risk Score', 'riskScore'),
                        value: `${devRiskValue}/100${devData.riskLevel ? ` (${devRiskLabel})` : ''}`,
                        tone: devRiskTone,
                    } : null,
                    devData.balanceSol !== undefined ? {
                        label: 'Số dư',
                        value: formatSolCompact(devData.balanceSol, 3),
                    } : null,
                    devData.totalTxCount !== undefined ? {
                        label: 'Số giao dịch',
                        value: devData.totalTxCount,
                    } : null,
                    devData.tokensDeployed !== undefined ? {
                        label: 'Token đã tạo',
                        value: devData.tokensDeployed,
                        tone: devData.tokensDeployed > 5 ? 'red' : devData.tokensDeployed > 2 ? 'yellow' : 'green',
                    } : null,
                    devData.walletAge !== undefined ? {
                        label: 'Tuổi ví',
                        value: `${devData.walletAge} ngày`,
                        tone: devData.walletAge < 7 ? 'red' : 'green',
                    } : null,
                    devData.hasSelledBefore !== undefined ? {
                        label: 'Đã bán token cũ',
                        value: devData.hasSelledBefore ? 'CÓ' : 'KHÔNG',
                        tone: devData.hasSelledBefore ? 'red' : 'green',
                    } : null,
                    devData.rugPullHistory !== undefined ? {
                        label: 'Lịch sử rug',
                        value: devData.rugPullHistory ? 'CÓ' : 'KHÔNG',
                        tone: devData.rugPullHistory ? 'red' : 'green',
                    } : null,
                    devData.holdingPercent !== undefined ? {
                        label: 'Đang hold',
                        value: `${safeNumber(devData.holdingPercent, 0).toFixed(1)}%`,
                        tone: safeNumber(devData.holdingPercent, 0) > 20 ? 'red' : 'green',
                    } : null,
                    devData.lastActivity ? {
                        label: 'Hoạt động cuối',
                        value: formatDateTime(devData.lastActivity),
                    } : null,
                ]) || '<div class="info-empty">Chưa có dữ liệu deployer.</div>'}
            </div>
        `;

        html += `
            <div class="info-card">
                <h4><i class="fas fa-star"></i> ${renderTerm('Token Score', 'tokenScore')}</h4>
                ${buildInfoRows([
                    tsData.totalScore !== undefined ? {
                        label: 'Tổng điểm',
                        value: `${tsData.totalScore}/100${tsData.verdict ? ` (${escapeHtml(tsData.verdict)})` : ''}`,
                        tone: tsData.totalScore >= 70 ? 'green' : tsData.totalScore >= 45 ? 'yellow' : 'red',
                    } : (typeof data.tokenScore === 'number' ? {
                        label: 'Tổng điểm',
                        value: `${data.tokenScore}/100`,
                    } : null),
                    tsData.metadataScore !== undefined ? {
                        label: renderTerm('Metadata', 'metadata'),
                        value: tsData.metadataScore,
                    } : null,
                    tsData.bondingCurveScore !== undefined ? {
                        label: renderTerm('Bonding Curve', 'bondingCurve'),
                        value: tsData.bondingCurveScore,
                    } : null,
                    tsData.uriScore !== undefined ? {
                        label: renderTerm('URI Score', 'uriScore'),
                        value: tsData.uriScore,
                    } : null,
                ]) || '<div class="info-empty">Chưa có dữ liệu chấm điểm token.</div>'}
            </div>
        `;

        const t10Color = safeNumber(holderStats?.top10Percent, 0) > 30 ? 'red' : safeNumber(holderStats?.top10Percent, 0) > 20 ? 'yellow' : 'green';
        const devColor = safeNumber(holderStats?.devHoldPercent, 0) > 20 ? 'red' : safeNumber(holderStats?.devHoldPercent, 0) > 10 ? 'yellow' : 'green';
        const bundleColor = safeNumber(holderStats?.bundleHoldPercent, 0) > 20 ? 'red' : 'green';
        const earlyBuyerColor = safeNumber(holderStats?.earlyBuyerHoldPercent, 0) > 20 ? 'red' : 'green';

        html += `
            <div class="info-card">
                <h4><i class="fas fa-chart-pie"></i> Phân bổ ${renderTerm('Holder', 'holder')}</h4>
                ${holderStats
                    ? buildInfoRows([
                        {
                            label: `${renderTerm('Holder', 'holder')} thực`,
                            value: `${holderStats.realHolderCount ?? 0}${typeof holderStats.filteredFunctionalCount === 'number' ? ` | Loc ${holderStats.filteredFunctionalCount}` : ''}`,
                        },
                        {
                            label: 'Top 10',
                            value: `${safeNumber(holderStats.top10Percent, 0).toFixed(1)}%${typeof holderStats.top10OwnersPercent === 'number' ? ` | Ví sở hữu ${holderStats.top10OwnersPercent.toFixed(1)}%` : ''}`,
                            tone: t10Color,
                        },
                        {
                            label: renderTerm('Dev', 'dev'),
                            value: `${safeNumber(holderStats.devHoldPercent, 0).toFixed(1)}%`,
                            tone: devColor,
                        },
                        {
                            label: renderTerm('Bundle', 'bundle'),
                            value: `${safeNumber(holderStats.bundleHoldPercent, 0).toFixed(1)}%`,
                            tone: bundleColor,
                        },
                        {
                            label: renderTerm('Early Buyers', 'earlyBuyers'),
                            value: `${safeNumber(holderStats.earlyBuyerHoldPercent, 0).toFixed(1)}%`,
                            tone: earlyBuyerColor,
                        },
                    ])
                    : '<div class="info-empty">Chưa có dữ liệu holder.</div>'}
            </div>
        `;

        const clusterRisk = clusterAnalysis?.riskLevel;
        const clusterTone = clusterRisk === 'HIGH' ? 'red' : clusterRisk === 'MEDIUM' ? 'yellow' : 'green';
        const sharedFunders = Array.isArray(clusterAnalysis?.sharedFunders) ? clusterAnalysis.sharedFunders : [];
        const sharedCount = sharedFunders.length;

        html += `
            <div class="info-card">
                <h4><i class="fas fa-project-diagram"></i> Phân tích ${renderTerm('Cluster', 'cluster')}</h4>
                ${clusterAnalysis
                    ? `
                        ${buildInfoRows([
                            {
                                label: 'Tín hiệu thắng',
                                value: sharedCount >= 3 ? 'MẠNH (x5+)' : 'CẦN THEO DÕI',
                                tone: sharedCount >= 3 ? 'green' : 'yellow',
                            },
                            {
                                label: `Có ${renderTerm('Cluster', 'cluster')}`,
                                value: clusterAnalysis.isLikelyCluster ? 'CÓ' : 'KHÔNG',
                                tone: clusterAnalysis.isLikelyCluster ? 'red' : 'green',
                            },
                            {
                                label: 'Mức rủi ro',
                                value: clusterRisk === 'HIGH' ? 'CAO' : clusterRisk === 'MEDIUM' ? 'TRUNG BÌNH' : 'THẤP',
                                tone: clusterTone,
                            },
                            {
                                label: 'Ví mẹ chung',
                                value: sharedCount,
                            },
                            {
                                label: 'Ví mới trong cluster',
                                value: `${clusterAnalysis.freshNewWalletCount || 0}/${clusterAnalysis.walletCount || 0}`,
                            },
                        ])}
                        ${sharedFunders.length > 0 ? `
                            <div class="sub-list">
                                <div class="sub-list-title">Ví mẹ chung</div>
                                ${sharedFunders.slice(0, 5).map((funder) => {
                                    const addr = typeof funder === 'string' ? funder : (funder.address || funder.wallet || '');
                                    const count = typeof funder === 'object' ? (funder.count || funder.fundedCount || '') : '';
                                    if (!addr) return '';
                                    return `
                                        <div class="sub-list-row">
                                            <a href="https://solscan.io/account/${encodeURIComponent(addr)}" target="_blank" rel="noreferrer" class="mono-link">${escapeHtml(addr)}</a>
                                            ${count ? `<span>${count} ví</span>` : ''}
                                        </div>
                                    `;
                                }).join('')}
                                ${sharedFunders.length > 5 ? `<div class="sub-list-more">... và ${sharedFunders.length - 5} ví mẹ khác</div>` : ''}
                            </div>
                        ` : ''}
                    `
                    : `<div class="info-empty">Chưa có dữ liệu ${renderTerm('Cluster', 'cluster')}.</div>`}
            </div>
        `;

        html += `
            <div class="info-card">
                <h4><i class="fas fa-clock"></i> Timeline & Snapshot</h4>
                ${buildInfoRows([
                    {
                        label: infoOnly ? 'Qua lọc lúc' : 'Ghi nhận lúc',
                        value: formatDateTime(recordedAt),
                    },
                    highestAt ? {
                        label: `${renderTerm('ATH', 'ath')} lúc`,
                        value: formatDateTime(highestAt),
                    } : null,
                    refreshedAt ? {
                        label: 'Làm mới market',
                        value: formatDateTime(refreshedAt),
                    } : null,
                    analysisAt ? {
                        label: 'Phân tích lúc',
                        value: formatDateTime(analysisAt),
                    } : null,
                    {
                        label: 'Độ mới dữ liệu',
                        value: dataFreshness,
                        tone: freshnessTone,
                    },
                    deployer ? {
                        label: renderTerm('Deployer', 'deployer'),
                        html: `<span class="analysis-inline-mono">${deployer}</span>`,
                        allowBreak: true,
                    } : null,
                ])}
            </div>
        `;

        html += `</div>`;
    }

    if (holderStats?.topHolders?.length > 0) {
        html += `<div class="section-title"><i class="fas fa-layer-group"></i> Top Holder chi tiết</div>`;
        html += `
            <div class="data-table-card">
                <div class="table-caption">Top ${Math.min(holderStats.topHolders.length, 10)} holder theo tỷ trọng cung (loại pool sẽ được đánh dấu riêng).</div>
                <div class="buyers-table-container">
                    <table class="buyers-table compact-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Ví</th>
                                <th>% cung</th>
                                <th>Vai trò</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        holderStats.topHolders.slice(0, 10).forEach((holder, index) => {
            const addr = holder.address || holder.owner || '';
            const pct = safeNumber(holder.percent || holder.percentage, 0);
            const role = holder.isDev ? 'Dev' : holder.isBundle ? 'Bundle' : holder.isPool ? 'Pool' : 'Holder';
            const tone = holder.isDev ? 'yellow' : holder.isBundle ? 'red' : holder.isPool ? '' : (pct > 10 ? 'red' : 'green');
            html += `
                <tr>
                    <td>${index + 1}</td>
                    <td>
                        <a href="https://solscan.io/account/${encodeURIComponent(addr)}" target="_blank" rel="noreferrer" class="mono-link" title="${escapeHtml(addr)}">${escapeHtml(addr || '---')}</a>
                    </td>
                    <td class="${tone}">${pct.toFixed(1)}%</td>
                    <td><span class="wallet-tag ${holder.isDev ? 'dev' : holder.isBundle ? 'white' : holder.isPool ? 'old' : 'old'}">${role}</span></td>
                </tr>
            `;
        });

        html += `
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    if (earlyBuyers && earlyBuyers.length > 0) {
        const tradeLookup = {};
        if (earlyBuyerTrades && earlyBuyerTrades.length > 0) {
            for (const trade of earlyBuyerTrades) {
                if (trade.trader) tradeLookup[trade.trader] = trade;
            }
        }

        const freshCount = earlyBuyers.filter((buyer) => buyer.isFreshNewWallet).length;
        const totalSolSpent = earlyBuyers.reduce((sum, buyer) => sum + safeNumber(buyer.solAmount, 0), 0);
        const cexFundedCount = earlyBuyers.filter((buyer) => buyer.sourceOfFunds?.hasCEXFunding).length;

        html += `<div class="section-title"><i class="fas fa-wallet"></i> ${renderTerm('Early Buyers', 'earlyBuyers')}</div>`;
        html += `
            <div class="summary-chip-grid buyers-summary-grid">
                <div class="summary-chip brand">
                    <span>Tổng buyer</span>
                    <strong>${earlyBuyers.length}</strong>
                </div>
                <div class="summary-chip warning">
                    <span>Ví mới</span>
                    <strong>${freshCount}</strong>
                </div>
                <div class="summary-chip positive">
                    <span>Tổng SOL mua</span>
                    <strong>${totalSolSpent.toFixed(2)} SOL</strong>
                </div>
                <div class="summary-chip">
                    <span>CEX funding</span>
                    <strong>${cexFundedCount}</strong>
                </div>
            </div>
            <div class="data-table-card">
                <div class="buyers-table-container">
                    <table class="buyers-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Ví</th>
                                <th>SOL mua</th>
                                <th>Token nhận</th>
                                <th>Loại</th>
                                <th>Số dư</th>
                                <th>Tuổi</th>
                                <th>TX</th>
                                <th>Nguồn vốn</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        earlyBuyers.forEach((buyer, idx) => {
            const tagClass = buyer.isFreshNewWallet ? 'white' : 'old';
            const tagText = buyer.isFreshNewWallet ? 'MỚI' : 'CŨ';
            const trade = tradeLookup[buyer.address];
            const tokenAmount = safeNumber(buyer.tokenAmount || trade?.tokenAmount, 0);
            const solAmount = safeNumber(buyer.solAmount || trade?.solAmount, 0);
            const sig = trade?.signature || buyer.signature || '';
            const sigShort = sig ? `${sig.substring(0, 8)}...` : '';
            const solscanUrl = sig ? `https://solscan.io/tx/${encodeURIComponent(sig)}` : '';
            const source = buyer.sourceOfFunds?.hasCEXFunding
                ? `<span class="analysis-source-cex">CEX</span>`
                : buyer.fundingWallets?.length > 0
                    ? `<span title="${escapeHtml((buyer.fundingWallets || []).slice(0, 3).join(', '))}">Ví (${buyer.fundingWallets.length})</span>`
                    : '<span class="analysis-source-muted">---</span>';

            html += `
                <tr>
                    <td>${idx + 1}</td>
                    <td>
                        <a href="https://solscan.io/account/${encodeURIComponent(buyer.address)}" target="_blank" rel="noreferrer" class="mono-link" title="${escapeHtml(buyer.address)}">${escapeHtml(buyer.address)}</a>
                        ${sigShort ? `<div class="table-subline"><a href="${solscanUrl}" target="_blank" rel="noreferrer"><i class="fas fa-external-link-alt"></i> ${sigShort}</a></div>` : ''}
                    </td>
                    <td class="green">${solAmount.toFixed(3)} SOL</td>
                    <td>${tokenAmount > 0 ? formatNumber(tokenAmount) : '---'}</td>
                    <td><span class="wallet-tag ${tagClass}">${tagText}</span></td>
                    <td>${safeNumber(buyer.balance, 0).toFixed(3)}</td>
                    <td>${buyer.walletAgeDays !== undefined ? `${buyer.walletAgeDays}d` : (buyer.walletAgeSeconds ? `${Math.floor(buyer.walletAgeSeconds / 86400)}d` : '---')}</td>
                    <td>${buyer.txCount || 0}</td>
                    <td>${source}</td>
                </tr>
            `;
        });

        html += `
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    html += `
        <div class="detail-footer">
            <span>${renderTerm('Deployer', 'deployer')}: ${deployer || '---'}</span>
            <span>${infoOnly ? 'Qua lọc' : 'Ghi nhận'}: ${formatDateTime(recordedAt)}</span>
            ${analysisAt ? `<span>Phân tích: ${formatDateTime(analysisAt)}</span>` : ''}
            <span>Dữ liệu: ${dataFreshness}</span>
        </div>
    `;

    html += `</div>`;

    liveAnalysis.innerHTML = html;
    liveAnalysis.dataset.launchMcapUsd = String(launchMcapUsd || 0);
    liveAnalysis.dataset.analysisMint = mint;
    hydrateTermAnnotations(liveAnalysis);
}
