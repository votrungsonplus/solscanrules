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
    const timeStr = tokenData.timestamp ? new Date(tokenData.timestamp).toLocaleString('vi-VN') : '---';
    const encodedMint = encodeURIComponent(mint);
    const encodedRouteAddress = encodeURIComponent(tokenData.axiomRouteAddress || mint);

    const circulatingMcapSol = tokenData.circulatingMcapSol || tokenData.marketCapSol || 0;
    const useSolPrice = solPrice || parseFloat(document.getElementById('solPrice')?.textContent?.replace('$', '') || 150);
    const circulatingMcapUsd = tokenData.circulatingMcapUsd || tokenData.marketCapUsd || (circulatingMcapSol * useSolPrice);
    const bondingProgress = tokenData.bondingCurveProgress || (tokenData.vSolInBondingCurve ? (tokenData.vSolInBondingCurve / 85) * 100 : 0);
    const gFee = globalFee || tokenData.globalFee || 0;
    const volume = tokenData.volume || (gFee * 100);
    const infoOnly = data.infoOnly === true;

    let html = `<div class="detail-card">`;

    // ── Header ──
    html += `
        <div class="detail-header">
            <div class="detail-title">
                <h3>${symbol} <span class="verdict-badge ${isPassed ? 'pass' : 'fail'}">${isPassed ? 'ĐẠT' : 'LOẠI'}</span></h3>
                <div style="font-size: 12px; color: var(--text-muted);">${name}</div>
                <div class="detail-mint">
                    <span>${safeMint}</span>
                    <button class="copy-btn" onclick="navigator.clipboard.writeText('${mint}')"><i class="fas fa-copy"></i></button>
                </div>
            </div>
            <div class="detail-links">
                <a href="https://pump.fun/coin/${encodedMint}" target="_blank" rel="noreferrer"><i class="fas fa-rocket"></i> Pump</a>
                <a href="https://dexscreener.com/solana/${encodedMint}" target="_blank" rel="noreferrer"><i class="fas fa-chart-area"></i> DexS</a>
                <a href="https://solscan.io/token/${encodedMint}" target="_blank" rel="noreferrer"><i class="fas fa-cube"></i> Solscan</a>
                <a href="https://trade.padre.gg/trade/solana/${encodedRouteAddress}" target="_blank" rel="noreferrer"><i class="fas fa-fire"></i> Padre</a>
            </div>
        </div>
    `;

    const launchMcap = tokenData.launchMcapUsd || 0;
    const highMcap = tokenData.highestMcapUsd || launchMcap;
    const peakMultiplier = launchMcap > 0 ? (highMcap / launchMcap).toFixed(1) : 1.0;

    // ── Market Data ──
    html += `
        <div class="market-data">
            <div class="market-item">
                <div class="label">${renderTerm('MC', 'mcCirc')}</div>
                <div class="value">${circulatingMcapSol > 0 ? circulatingMcapSol.toFixed(1) + ' SOL' : '---'}</div>
            </div>
            <div class="market-item">
                <div class="label">${renderTerm('MC', 'marketCap')} USD</div>
                <div class="value green">${circulatingMcapUsd > 0 ? '$' + formatNumber(circulatingMcapUsd) : '---'}</div>
            </div>
            <div class="market-item">
                <div class="label">Dinh (${renderTerm('ATH', 'ath')})</div>
                <div class="value highlight-val up">$${highMcap > 0 ? formatNumber(highMcap) : '---'} <span style="font-size:12px; opacity:0.8">(x${peakMultiplier})</span></div>
            </div>
            <div class="market-item">
                <div class="label">${renderTerm('Volume', 'volume')}</div>
                <div class="value">${volume > 0 ? volume.toFixed(1) + ' SOL' : '---'}</div>
            </div>
            <div class="market-item">
                <div class="label">${renderTerm('Global Fee', 'globalFee')}</div>
                <div class="value yellow">${gFee > 0 ? gFee.toFixed(4) + ' SOL' : '---'}</div>
            </div>
        </div>
    `;

    if (infoOnly) {
        const launchMcapUsd = tokenData.launchMcapUsd || 0;
        const highestMcapUsd = tokenData.highestMcapUsd || launchMcapUsd;
        const currentMcapUsd = tokenData.currentMcapUsd || tokenData.marketCapUsd || highestMcapUsd;
        const passedAt = tokenData.timestamp ? new Date(tokenData.timestamp).toLocaleString('vi-VN') : '---';
        const highestAt = tokenData.highestMcapTimestamp
            ? new Date(tokenData.highestMcapTimestamp).toLocaleString('vi-VN')
            : '---';
        const refreshedAt = tokenData.refreshedAt
            ? new Date(tokenData.refreshedAt).toLocaleString('vi-VN')
            : '---';
        const performancePct = launchMcapUsd > 0
            ? ((highestMcapUsd - launchMcapUsd) / launchMcapUsd) * 100
            : 0;

        html += `
            <div class="section-title"><i class="fas fa-circle-info"></i> Thông tin token</div>
            <div class="info-only-actions">
                <button class="refresh-btn" id="refreshPassedInfoBtn" onclick="refreshPassedTokenInfo('${mint}')">
                    <i class="fas fa-rotate"></i>
                    <span>Cập nhật trạng thái</span>
                </button>
            </div>
            <div class="info-grid">
                <div class="info-card">
                    <h4><i class="fas fa-coins"></i> Ảnh chụp thị trường</h4>
                    <div class="info-row"><span class="label">${renderTerm('MC', 'marketCap')} lúc qua lọc</span><span class="val">${launchMcapUsd > 0 ? '$' + formatNumber(launchMcapUsd) : '---'}</span></div>
                    <div class="info-row"><span class="label">${renderTerm('MC', 'marketCap')} hiện tại</span><span class="val yellow">${currentMcapUsd > 0 ? '$' + formatNumber(currentMcapUsd) : '---'}</span></div>
                    <div class="info-row"><span class="label">${renderTerm('MC', 'marketCap')} cao nhất</span><span class="val green">${highestMcapUsd > 0 ? '$' + formatNumber(highestMcapUsd) : '---'}</span></div>
                    <div class="info-row"><span class="label">Hiệu suất</span><span class="val ${performancePct >= 0 ? 'green' : 'red'}">${performancePct >= 0 ? '+' : ''}${performancePct.toFixed(1)}%</span></div>
                </div>
                <div class="info-card">
                    <h4><i class="fas fa-wave-square"></i> Dữ liệu thị trường</h4>
                    <div class="info-row"><span class="label">${renderTerm('Volume', 'volume')} (24h)</span><span class="val highlight-val">${tokenData.volume > 0 ? tokenData.volume.toFixed(1) + ' SOL' : '---'}</span></div>
                    <div class="info-row"><span class="label">${renderTerm('Global Fee', 'globalFee')}</span><span class="val highlight-val yellow">${tokenData.globalFee > 0 ? tokenData.globalFee.toFixed(4) + ' SOL' : '---'}</span></div>
                    <div class="info-row"><span class="label">${renderTerm('Holder', 'holder')}</span><span class="val highlight-val green">${holderStats?.realHolderCount || '---'}</span></div>
                    <div class="info-row"><span class="label">Cập nhật lúc</span><span class="val">${refreshedAt}</span></div>
                </div>
                <div class="info-card">
                    <h4><i class="fas fa-clock"></i> Dòng thời gian</h4>
                    <div class="info-row"><span class="label">Qua lọc lúc</span><span class="val">${passedAt}</span></div>
                    <div class="info-row"><span class="label">${renderTerm('ATH', 'ath')} lúc</span><span class="val">${highestAt}</span></div>
                    <div class="info-row"><span class="label">${renderTerm('Deployer', 'deployer')}</span><span class="val" style="font-size: 10px;">${deployer || '---'}</span></div>
                </div>
            </div>
            <div style="font-size: 10px; color: var(--text-muted); text-align: right; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border);">
                Token đã vượt qua bộ lọc. Nhấn "Cập nhật trạng thái" để làm mới dữ liệu.
            </div>
        `;

        html += `</div>`;
        liveAnalysis.innerHTML = html;
        hydrateTermAnnotations(liveAnalysis);
        return;
    }

    // ── Bonding Curve Progress ──
    const vSolInCurve = tokenData.vSolInBondingCurve || 0;
    if (bondingProgress > 0) {
        const curveStatus = bondingProgress >= 100 ? 'ĐÃ LÊN DEX' : (bondingProgress > 70 ? 'SẮP ĐẦY' : 'ĐANG TÍCH LŨY');
        const curveStatusColor = bondingProgress >= 100 ? 'var(--green)' : (bondingProgress > 70 ? 'var(--yellow)' : 'var(--text-muted)');
        html += `
            <div class="progress-bar-container">
                <div class="progress-label">
                    <span>${renderTerm('Bonding Curve', 'bondingCurve')} <span style="font-size: 10px; color: ${curveStatusColor};">(${curveStatus})</span></span>
                    <span>${bondingProgress.toFixed(1)}%${vSolInCurve > 0 ? ` — ${vSolInCurve.toFixed(1)} SOL trong curve` : ''}</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill ${bondingProgress > 70 ? 'high' : ''}" style="width: ${Math.min(bondingProgress, 100)}%"></div>
                </div>
            </div>
        `;
    } else {
        html += `
            <div class="progress-bar-container">
                <div class="progress-label">
                    <span>${renderTerm('Bonding Curve', 'bondingCurve')}</span>
                    <span style="color: var(--text-muted); font-size: 11px;">Không có dữ liệu (có thể đã lên DEX)</span>
                </div>
            </div>
        `;
    }

    // ── Verdict ──
    html += `
        <div class="verdict-box ${isPassed ? 'pass' : 'fail'}">
            <i class="fas ${isPassed ? 'fa-check-double' : 'fa-shield-alt'}"></i>
            <span>${formatRichText(ruleResult.summary || (isPassed ? 'Tất cả quy tắc đều đạt.' : 'Bị chặn bởi bộ quy tắc.'))}</span>

            <button class="refresh-btn" id="refreshBtn" onclick="manualRefresh('${mint}')">
                <i class="fas fa-sync-alt"></i>
                <span>Cập nhật trạng thái</span>
            </button>
        </div>
    `;

    // ── Rule Results ──
    if (ruleResult.results && ruleResult.results.length > 0) {
        html += `<div class="section-title"><i class="fas fa-list-check"></i> Kết quả bộ quy tắc (${ruleResult.results.filter((r) => r.passed).length}/${ruleResult.results.length} đạt)</div>`;
        html += `<div class="rules-grid">`;
        for (const r of ruleResult.results) {
            const cls = r.passed ? 'pass' : (r.ruleType === 'INFO' ? 'info' : 'fail');
            const icon = r.passed ? 'fa-check-circle' : (r.ruleType === 'INFO' ? 'fa-info-circle' : 'fa-times-circle');
            html += `
                <div class="rule-row ${cls}">
                    <i class="fas ${icon} rule-icon"></i>
                    <div class="rule-body">
                        <div class="rule-name">
                            ${getRuleDisplayName(r.ruleId, r.ruleName)}
                            <span class="rule-type-badge ${r.ruleType.toLowerCase()}">${getRuleTypeLabel(r.ruleType)}</span>
                        </div>
                        <div class="rule-reason">${formatRichText(r.reason)}</div>
                    </div>
                </div>
            `;
        }
        html += `</div>`;
    } else if (ruleResult.isLegacy) {
        html += `
            <div style="padding: 20px; text-align: center; background: var(--bg-card); border-radius: var(--radius-md); border: 1px dashed var(--border); margin-bottom: 20px;">
                <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.6;">${formatRichText(ruleResult.summary)}</div>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">(Bản ghi cũ — chưa có dữ liệu quy tắc chi tiết)</div>
            </div>
        `;
    }

    // ── Dev & Token Score Info ──
    const devData = devAnalysis || {};
    const tsData = (typeof tokenScore === 'object') ? tokenScore : {};

    if (devData.address || tsData.totalScore !== undefined || data.devRiskScore !== undefined) {
        html += `<div class="info-grid">`;

        html += `<div class="info-card"><h4><i class="fas fa-user-shield"></i> Phân tích ${renderTerm('Dev', 'dev')}</h4>`;
        if (devData.address) {
            const riskColor = devData.riskScore >= 70 ? 'red' : devData.riskScore >= 40 ? 'yellow' : 'green';
            const riskLevel = escapeHtml(devData.riskLevel || '---');
            const devSolscan = `https://solscan.io/account/${encodeURIComponent(devData.address)}`;
            html += `
                <div class="info-row"><span class="label">Địa chỉ</span><span class="val" style="font-size: 10px;"><a href="${devSolscan}" target="_blank" rel="noreferrer" style="color: var(--text-secondary); text-decoration: none;">${escapeHtml(devData.address)}</a></span></div>
                <div class="info-row"><span class="label">${renderTerm('Risk Score', 'riskScore')}</span><span class="val ${riskColor}">${devData.riskScore}/100 (${riskLevel})</span></div>
                <div class="info-row"><span class="label">Số dư</span><span class="val">${(devData.balanceSol || 0).toFixed(3)} SOL</span></div>
                <div class="info-row"><span class="label">Số giao dịch</span><span class="val">${devData.totalTxCount || 0}</span></div>
                <div class="info-row"><span class="label">Token đã tạo</span><span class="val ${(devData.tokensDeployed || 0) > 5 ? 'red' : (devData.tokensDeployed || 0) > 2 ? 'yellow' : 'green'}">${devData.tokensDeployed || 0}${devData.tokensDeployed > 3 ? ' ⚠️' : ''}</span></div>
                <div class="info-row"><span class="label">Tuổi ví</span><span class="val ${(devData.walletAge || 0) < 7 ? 'red' : 'green'}">${devData.walletAge || 0} ngày</span></div>
            `;
            if (devData.hasSelledBefore !== undefined || devData.rugPullHistory !== undefined) {
                html += `<div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border);">`;
                if (devData.hasSelledBefore !== undefined) {
                    html += `<div class="info-row"><span class="label">Đã bán token cũ</span><span class="val ${devData.hasSelledBefore ? 'red' : 'green'}">${devData.hasSelledBefore ? 'CÓ' : 'KHÔNG'}</span></div>`;
                }
                if (devData.rugPullHistory !== undefined) {
                    html += `<div class="info-row"><span class="label">Lịch sử rug</span><span class="val ${devData.rugPullHistory ? 'red' : 'green'}">${devData.rugPullHistory ? 'CÓ ⚠️' : 'KHÔNG'}</span></div>`;
                }
                if (devData.holdingPercent !== undefined) {
                    html += `<div class="info-row"><span class="label">Đang hold</span><span class="val ${devData.holdingPercent > 20 ? 'red' : 'green'}">${devData.holdingPercent.toFixed(1)}%</span></div>`;
                }
                if (devData.lastActivity) {
                    const lastActStr = new Date(devData.lastActivity).toLocaleString('vi-VN');
                    html += `<div class="info-row"><span class="label">Hoạt động cuối</span><span class="val" style="font-size: 10px;">${lastActStr}</span></div>`;
                }
                html += `</div>`;
            }
        } else if (data.devRiskScore !== undefined) {
            html += `<div class="info-row"><span class="label">${renderTerm('Risk Score', 'riskScore')}</span><span class="val">${data.devRiskScore}/100</span></div>`;
        } else {
            html += `<div style="color: var(--text-muted); font-size: 11px;">Chưa có dữ liệu</div>`;
        }
        html += `</div>`;

        html += `<div class="info-card"><h4><i class="fas fa-star"></i> ${renderTerm('Token Score', 'tokenScore')}</h4>`;
        if (tsData.totalScore !== undefined) {
            const scoreColor = tsData.totalScore >= 70 ? 'green' : tsData.totalScore >= 45 ? 'yellow' : 'red';
            const verdict = escapeHtml(tsData.verdict || '---');
            html += `
                <div class="info-row"><span class="label">Tổng điểm</span><span class="val ${scoreColor}">${tsData.totalScore}/100 (${verdict})</span></div>
                <div class="info-row"><span class="label">${renderTerm('Metadata', 'metadata')}</span><span class="val">${tsData.metadataScore || 0}</span></div>
                <div class="info-row"><span class="label">${renderTerm('Bonding Curve', 'bondingCurve')}</span><span class="val">${tsData.bondingCurveScore || 0}</span></div>
                <div class="info-row"><span class="label">${renderTerm('URI Score', 'uriScore')}</span><span class="val">${tsData.uriScore || 0}</span></div>
            `;
        } else if (data.tokenScore !== undefined && typeof data.tokenScore === 'number') {
            html += `<div class="info-row"><span class="label">Điểm</span><span class="val">${data.tokenScore}/100</span></div>`;
        } else {
            html += `<div style="color: var(--text-muted); font-size: 11px;">Chưa có dữ liệu</div>`;
        }
        html += `</div>`;

        html += `</div>`;
    }

    // ── Holder Stats ──
    if (holderStats) {
        html += `<div class="section-title"><i class="fas fa-users"></i> Phân bổ ${renderTerm('Holder', 'holder')}</div>`;
        html += `<div class="info-grid">`;

        html += `<div class="info-card"><h4><i class="fas fa-chart-pie"></i> Độ tập trung (% cung, trừ pool)</h4>`;
        const t10Color = holderStats.top10Percent > 30 ? 'red' : holderStats.top10Percent > 20 ? 'yellow' : 'green';
        const devColor = holderStats.devHoldPercent > 20 ? 'red' : holderStats.devHoldPercent > 10 ? 'yellow' : 'green';
        const bundleColor = holderStats.bundleHoldPercent > 20 ? 'red' : 'green';
        const earlyBuyerColor = holderStats.earlyBuyerHoldPercent > 20 ? 'red' : 'green';
        html += `
            <div class="info-row"><span class="label">${renderTerm('Holder', 'holder')} thực</span><span class="val">${holderStats.realHolderCount ?? 0}${typeof holderStats.filteredFunctionalCount === 'number' ? ` | Lọc: ${holderStats.filteredFunctionalCount}` : ''}</span></div>
            <div class="info-row"><span class="label">Top 10</span><span class="val ${t10Color}">${holderStats.top10Percent?.toFixed(1)}%${typeof holderStats.top10OwnersPercent === 'number' ? ` | Ví sở hữu: ${holderStats.top10OwnersPercent.toFixed(1)}%` : ''}</span></div>
            <div class="info-row"><span class="label">${renderTerm('Dev', 'dev')}</span><span class="val ${devColor}">${holderStats.devHoldPercent?.toFixed(1)}%</span></div>
            <div class="info-row"><span class="label">${renderTerm('Bundle', 'bundle')}</span><span class="val ${bundleColor}">${holderStats.bundleHoldPercent?.toFixed(1)}%</span></div>
            <div class="info-row"><span class="label">${renderTerm('Early Buyers', 'earlyBuyers')}</span><span class="val ${earlyBuyerColor}">${holderStats.earlyBuyerHoldPercent?.toFixed(1)}%</span></div>
        `;

        if (holderStats.topHolders && holderStats.topHolders.length > 0) {
            html += `<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border);">
                <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 4px;">Chi tiết Top ${Math.min(holderStats.topHolders.length, 10)} Holder:</div>
                <table style="width: 100%; font-size: 10px; border-collapse: collapse;">
                    <thead><tr style="color: var(--text-muted);">
                        <th style="text-align: left; padding: 2px 4px;">#</th>
                        <th style="text-align: left; padding: 2px 4px;">Ví</th>
                        <th style="text-align: right; padding: 2px 4px;">%</th>
                        <th style="text-align: right; padding: 2px 4px;">Vai trò</th>
                    </tr></thead><tbody>`;
            holderStats.topHolders.slice(0, 10).forEach((h, i) => {
                const addr = h.address || h.owner || '';
                const pct = h.percent || h.percentage || 0;
                const role = h.isDev ? 'Dev' : (h.isBundle ? 'Bundle' : (h.isPool ? 'Pool' : ''));
                const roleColor = h.isDev ? 'var(--yellow)' : (h.isBundle ? 'var(--red)' : (h.isPool ? 'var(--text-muted)' : 'var(--text-secondary)'));
                html += `<tr style="border-top: 1px solid var(--border);">
                    <td style="padding: 2px 4px; color: var(--text-muted);">${i + 1}</td>
                    <td style="padding: 2px 4px; font-family: 'JetBrains Mono', monospace;">
                        <a href="https://solscan.io/account/${encodeURIComponent(addr)}" target="_blank" rel="noreferrer" style="color: var(--text-secondary); text-decoration: none;" title="${escapeHtml(addr)}">${addr ? addr.substring(0, 6) + '...' + addr.slice(-4) : '---'}</a>
                    </td>
                    <td style="padding: 2px 4px; text-align: right; font-weight: 600; color: ${pct > 10 ? 'var(--red)' : 'var(--green)'};">${pct.toFixed(1)}%</td>
                    <td style="padding: 2px 4px; text-align: right; font-size: 9px; color: ${roleColor};">${role}</td>
                </tr>`;
            });
            html += `</tbody></table></div>`;
        }

        html += `</div>`;

        html += `<div class="info-card"><h4><i class="fas fa-project-diagram"></i> Phân tích ${renderTerm('Cluster', 'cluster')}</h4>`;
        if (clusterAnalysis) {
            const clRisk = clusterAnalysis.riskLevel;
            const clColor = clRisk === 'HIGH' ? 'red' : clRisk === 'MEDIUM' ? 'yellow' : 'green';
            const sharedCount = clusterAnalysis.sharedFunders?.length || 0;
            const isWinnerSignal = sharedCount >= 3;
            const clRiskLabel = clRisk === 'HIGH'
                ? 'CAO'
                : clRisk === 'MEDIUM'
                    ? 'TRUNG BÌNH'
                    : 'THẤP';

            html += `
                <div class="info-row"><span class="label">Tín hiệu thắng</span><span class="val ${isWinnerSignal ? 'green' : 'yellow'}" style="font-weight:700">${isWinnerSignal ? 'MẠNH (x5+)' : 'CẦN THEO DÕI'}</span></div>
                <div class="info-row"><span class="label">Có ${renderTerm('Cluster', 'cluster')}</span><span class="val ${clusterAnalysis.isLikelyCluster ? 'red' : 'green'}">${clusterAnalysis.isLikelyCluster ? 'CÓ' : 'KHÔNG'}</span></div>
                <div class="info-row"><span class="label">Mức rủi ro</span><span class="val ${clColor}">${clRiskLabel}</span></div>
                <div class="info-row"><span class="label">Ví mẹ chung</span><span class="val" style="font-weight:700">${sharedCount}</span></div>
                <div class="info-row"><span class="label">Ví mới trong cluster</span><span class="val">${clusterAnalysis.freshNewWalletCount || 0}/${clusterAnalysis.walletCount || 0}</span></div>
            `;

            if (clusterAnalysis.sharedFunders && clusterAnalysis.sharedFunders.length > 0) {
                html += `<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border);">
                    <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 4px;">Ví mẹ chung:</div>`;
                for (const funder of clusterAnalysis.sharedFunders.slice(0, 5)) {
                    const fAddr = typeof funder === 'string' ? funder : (funder.address || funder.wallet || '');
                    const fCount = typeof funder === 'object' ? (funder.count || funder.fundedCount || '') : '';
                    if (fAddr) {
                        html += `<div style="font-size: 9px; font-family: 'JetBrains Mono', monospace; color: var(--text-secondary); margin: 2px 0;">
                            <a href="https://solscan.io/account/${encodeURIComponent(fAddr)}" target="_blank" rel="noreferrer" style="color: var(--yellow); text-decoration: none;">${escapeHtml(fAddr)}</a>
                            ${fCount ? `<span style="color: var(--text-muted);"> (cấp vốn ${fCount} ví)</span>` : ''}
                        </div>`;
                    }
                }
                if (clusterAnalysis.sharedFunders.length > 5) {
                    html += `<div style="font-size: 9px; color: var(--text-muted);">... và ${clusterAnalysis.sharedFunders.length - 5} ví mẹ khác</div>`;
                }
                html += `</div>`;
            }
        } else {
            html += `<div style="color: var(--text-muted); font-size: 11px;">Chưa có dữ liệu ${renderTerm('Cluster', 'cluster')}</div>`;
        }
        html += `</div>`;

        html += `</div>`;
    }

    // ── Early Buyers Table ──
    if (earlyBuyers && earlyBuyers.length > 0) {
        const tradeLookup = {};
        if (earlyBuyerTrades && earlyBuyerTrades.length > 0) {
            for (const t of earlyBuyerTrades) {
                if (t.trader) tradeLookup[t.trader] = t;
            }
        }

        const freshCount = earlyBuyers.filter(b => b.isFreshNewWallet).length;
        const totalSolSpent = earlyBuyers.reduce((sum, b) => sum + (b.solAmount || 0), 0);

        html += `<div class="section-title"><i class="fas fa-wallet"></i> ${renderTerm('Early Buyers', 'earlyBuyers')} (${earlyBuyers.length}) — <span style="color: var(--yellow);">${freshCount} ví mới</span> | Tổng: <span style="color: var(--green);">${totalSolSpent.toFixed(2)} SOL</span></div>`;
        html += `
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
            const tokenAmount = buyer.tokenAmount || trade?.tokenAmount || 0;
            const solAmount = buyer.solAmount || trade?.solAmount || 0;
            const sig = trade?.signature || buyer.signature || '';
            const sigShort = sig ? sig.substring(0, 8) + '...' : '';
            const source = buyer.sourceOfFunds?.hasCEXFunding ? `<span style="color: var(--green);">CEX</span>` :
                (buyer.fundingWallets?.length > 0 ? `<span title="${escapeHtml((buyer.fundingWallets || []).slice(0, 3).join(', '))}">Ví (${buyer.fundingWallets.length})</span>` : '<span style="color: var(--text-muted);">---</span>');
            const solscanUrl = sig ? `https://solscan.io/tx/${encodeURIComponent(sig)}` : '';

            html += `
                <tr>
                    <td style="color: var(--text-muted); font-size: 10px;">${idx + 1}</td>
                    <td style="font-size: 10px; font-family: 'JetBrains Mono', monospace;">
                        <a href="https://solscan.io/account/${encodeURIComponent(buyer.address)}" target="_blank" rel="noreferrer" style="color: var(--text-secondary); text-decoration: none;" title="${escapeHtml(buyer.address)}">${escapeHtml(buyer.address)}</a>
                        ${sigShort ? `<div style="font-size: 9px; color: var(--text-muted); margin-top: 2px;"><a href="${solscanUrl}" target="_blank" rel="noreferrer" style="color: var(--text-muted);" title="Xem giao dịch trên Solscan"><i class="fas fa-external-link-alt" style="font-size: 8px;"></i> ${sigShort}</a></div>` : ''}
                    </td>
                    <td style="font-weight: 700; color: var(--green); white-space: nowrap;">${solAmount.toFixed(3)} SOL</td>
                    <td style="white-space: nowrap; font-size: 11px;">${tokenAmount > 0 ? formatNumber(tokenAmount) : '---'}</td>
                    <td><span class="wallet-tag ${tagClass}">${tagText}</span></td>
                    <td>${(buyer.balance || 0).toFixed(3)}</td>
                    <td>${buyer.walletAgeDays !== undefined ? buyer.walletAgeDays + 'd' : (buyer.walletAgeSeconds ? Math.floor(buyer.walletAgeSeconds / 86400) + 'd' : '---')}</td>
                    <td>${buyer.txCount || 0}</td>
                    <td style="font-size: 11px;">${source}</td>
                </tr>
            `;
        });
        html += `</tbody></table>`;
    }

    // ── Footer ──
    const analysisAt = tokenData.analysisTimestamp
        ? new Date(tokenData.analysisTimestamp).toLocaleString('vi-VN')
        : null;
    const dataAgeMs = tokenData.analysisTimestamp ? (Date.now() - tokenData.analysisTimestamp) : null;
    const dataAgeStr = dataAgeMs !== null
        ? (dataAgeMs < 60000 ? `${Math.floor(dataAgeMs / 1000)}s trước`
            : dataAgeMs < 3600000 ? `${Math.floor(dataAgeMs / 60000)}m trước`
            : `${Math.floor(dataAgeMs / 3600000)}h trước`)
        : null;
    const freshnessColor = dataAgeMs !== null
        ? (dataAgeMs < 60000 ? 'var(--green)' : dataAgeMs < 300000 ? 'var(--yellow)' : 'var(--red)')
        : 'var(--text-muted)';

    html += `
        <div class="detail-footer">
            <span>${renderTerm('Deployer', 'deployer')}: ${deployer || '---'}</span>
            <span>
                Token tạo: ${timeStr}
                ${analysisAt ? ` | Phân tích: ${analysisAt}` : ''}
                ${dataAgeStr ? ` <span style="color: ${freshnessColor}; font-weight: 600;">(${dataAgeStr})</span>` : ''}
            </span>
        </div>
    `;

    html += `</div>`;

    liveAnalysis.innerHTML = html;
    hydrateTermAnnotations(liveAnalysis);
}
