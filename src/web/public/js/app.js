/* ═══════════════════════════════════════════════════════════
   SCAN SOL BOT - Professional Dashboard Client
   Real-time Socket.IO + comprehensive data display
   ═══════════════════════════════════════════════════════════ */

const socket = io();

// ── DOM Elements ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const tokenFeed = $('#tokenFeed');
const liveAnalysis = $('#liveAnalysis');
const rulesContainer = $('#rulesContainer');
const ruleProfilesContainer = $('#ruleProfilesContainer');
const passedTokensContainer = $('#passedTokensContainer');
const refreshPassedBtn = $('#refreshPassedBtn');
const top10Container = $('#top10Container');
const tradeHistoryContainer = $('#tradeHistoryContainer');
const feedCounter = $('#feedCounter');
const connectionStatus = $('#connectionStatus');

// Stats elements
const solPriceEl = $('#solPrice');
const totalScannedEl = $('#totalScanned');
const totalPassedEl = $('#totalPassed');
const totalBoughtEl = $('#totalBought');
const dailyPnlEl = $('#dailyPnl');
const uptimeEl = $('#uptime');
const pnlChip = $('#pnlChip');

// Config elements
const autoBuyToggle = $('#autoBuyToggle');
const autoSellToggle = $('#autoSellToggle');
const buyAmountInput = $('#buyAmountInput');
const takeProfitInput = $('#takeProfitInput');
const stopLossInput = $('#stopLossInput');
const maxPositionsInput = $('#maxPositionsInput');
const dailyLossInput = $('#dailyLossInput');
const earlyBuyersInput = $('#earlyBuyersInput');
const minBuyersToPassInput = $('#minBuyersToPassInput');
const showAllBuyersToggle = $('#showAllBuyersToggle');
const buySlippageInput = $('#buySlippageInput');
const sellSlippageInput = $('#sellSlippageInput');
const activeRuleProfileName = $('#activeRuleProfileName');
const activeRuleProfileBadge = $('#activeRuleProfileBadge');
const activeRuleProfileHint = $('#activeRuleProfileHint');
const contractSearch = $('#contractSearch');
const searchBtn = $('#searchBtn');
const autoReloadSelect = $('#autoReloadSelect');
const autoReloadCountdown = $('#autoReloadCountdown');

const AUTO_RELOAD_STORAGE_KEY = 'scan-sol-bot:auto-reload-seconds';
const DEFAULT_AUTO_RELOAD_SECONDS = 30;
const AUTO_RELOAD_TICK_MS = 250;

// ── State ──
let feedItems = new Map(); // mint -> element
let currentFilter = 'all';
let feedCount = 0;
let startTime = Date.now();
let solPrice = 0;
let analyzedMints = new Set(); // Prevent double-counting scanned tokens
let countedPasses = new Set(); // Prevent double-counting passed tokens
let selectedMint = null; // Track currently viewing token to prevent auto-jump
let currentRuleProfiles = [];
let activeRuleProfile = 'custom';
let autoReloadSeconds = DEFAULT_AUTO_RELOAD_SECONDS;
let autoReloadDeadline = Date.now() + DEFAULT_AUTO_RELOAD_SECONDS * 1000;
let autoReloadTimer = null;

const TERM_TOOLTIPS = {
    pnl: 'Profit & Loss — Lợi hoặc lỗ của giao dịch hay danh mục.',
    marketCap: 'Market Cap — Vốn hoa thi truong cua token.',
    ath: 'All-Time High — Muc cao nhat token da dat duoc.',
    volume: 'Volume — Khoi luong giao dich.',
    globalFee: 'Tong phi giao dich, thuong xap xi Volume x 1%.',
    bondingCurve: 'Bonding Curve — Tien do duong cong gia tren pump.fun; 100% la len DEX.',
    riskScore: 'Risk Score — Diem danh gia muc do rui ro.',
    tokenScore: 'Token Score — Diem danh gia chat luong token.',
    metadata: 'Metadata — Thong tin mo ta cua token.',
    uriScore: 'URI Score — Diem danh gia duong dan metadata.',
    dev: 'Dev — Vi deployer hoac nguoi tao token.',
    deployer: 'Deployer — Vi tao token.',
    whiteWallet: 'White Wallet — Vi moi/sach, it lich su giao dich.',
    cex: 'CEX — San giao dich tap trung.',
    cluster: 'Cluster — Nhom vi co lien he nguon von hoac hanh vi.',
    bundle: 'Bundle — Cum lenh/nhom vi di cung nhau.',
    earlyBuyers: 'Early Buyers — Cac vi mua trong nhung giao dich dau tien cua token.',
    holder: 'Holder — Vi dang nam giu token.',
    mint: 'Mint — Dia chi token tren blockchain Solana.',
    mcCirc: 'MC luu hanh — Von hoa tinh tren luong cung dang luu hanh.',
    liveStatus: 'LIVE — Dang co du lieu thi truong moi va tiep tuc duoc cap nhat.',
    autoBuy: 'Auto-Buy — Tu dong mua khi token vuot qua bo loc quy tac.',
    autoSell: 'Auto-Sell — Tu dong ban khi cham Take Profit, Stop Loss hoac phat hien rug.',
    slippage: 'Slippage — Do truot gia chap nhan khi khop lenh.',
    takeProfit: 'Take Profit — Nguong loi nhuan de tu dong chot loi.',
    stopLoss: 'Stop Loss — Nguong lo toi da de tu dong cat lo.',
    sniper: 'Sniper — Mua/ban thu cong tuc thi theo dia chi mint.',
    jitoBundle: 'Jito Bundle — Cach gui giao dich qua mang Jito de tang kha nang lenh duoc vao block va giam front-run.',
};

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderTerm(label, tooltipKeyOrText) {
    const tooltip = TERM_TOOLTIPS[tooltipKeyOrText] || tooltipKeyOrText || '';
    const safeLabel = escapeHtml(label);
    const safeTooltip = escapeHtml(tooltip);
    return `<span class="term-en" data-tooltip="${safeTooltip}">${safeLabel}</span>`;
}

function formatRichText(value = '') {
    let html = escapeHtml(value);
    const replacements = [
        ['Risk Score', renderTerm('Risk Score', 'riskScore')],
        ['Token Score', renderTerm('Token Score', 'tokenScore')],
        ['Global Fee', renderTerm('Global Fee', 'globalFee')],
        ['Bonding Curve', renderTerm('Bonding Curve', 'bondingCurve')],
        ['White Wallet', renderTerm('White Wallet', 'whiteWallet')],
        ['Early Buyers', renderTerm('Early Buyers', 'earlyBuyers')],
        ['Early Buyer', renderTerm('Early Buyer', 'earlyBuyers')],
        ['Deployer', renderTerm('Deployer', 'deployer')],
        ['Bundle', renderTerm('Bundle', 'bundle')],
        ['Cluster', renderTerm('Cluster', 'cluster')],
        ['Volume', renderTerm('Volume', 'volume')],
        ['Market Cap', renderTerm('Market Cap', 'marketCap')],
        ['MCap', renderTerm('MCap', 'marketCap')],
        ['ATH', renderTerm('ATH', 'ath')],
        ['CEX', renderTerm('CEX', 'cex')],
        ['Dev', renderTerm('Dev', 'dev')],
    ];

    for (const [needle, replacement] of replacements) {
        html = html.replaceAll(needle, replacement);
    }

    return html.replace(/\n/g, '<br>');
}

function hydrateTermAnnotations(root = document) {
    root.querySelectorAll('.term-en').forEach((el) => {
        const tooltip = el.dataset.tooltip;
        if (!tooltip) return;
        el.setAttribute('title', tooltip);
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', `${el.textContent.trim()}: ${tooltip}`);
    });
}

const PROFILE_COPY = {
    strict_current: {
        name: 'Gat - Logic hien tai',
        description: 'Preset chat nhat, bam sat logic hien tai de uu tien loc sach.',
    },
    balanced_backup3: {
        name: 'Can bang - Backup3',
        description: 'Preset can bang, gan voi backup3 va la diem giua de so sanh cac chien luoc.',
    },
    loose_backup2: {
        name: 'Thoang - Backup2',
        description: 'Preset de thoang hon de tang so keo, gan voi tinh than backup2.',
    },
    custom: {
        name: 'Tuy chinh',
        description: 'Trang thai hien tai sau khi chinh tay. Ap lai preset de quay ve cau hinh chuan.',
    },
};

const RULE_TYPE_LABELS = {
    REQUIRE: 'BAT BUOC',
    BLOCK: 'CHAN',
    ALERT: 'CANH BAO',
    INFO: 'TIN HIEU',
    'PRE-SCAN': 'SO BO',
};

const RULE_COPY = {
    white_wallet_from_deployer: `${renderTerm('White Wallet', 'whiteWallet')} tu ${renderTerm('Deployer', 'deployer')}`,
    white_wallet_from_cex: `${renderTerm('White Wallet', 'whiteWallet')} tu ${renderTerm('CEX', 'cex')}`,
    same_buy_amount: 'Phat hien mua cung luong',
    global_fee_threshold: `${renderTerm('Global Fee', 'globalFee')} toi thieu`,
    cluster_detection: `Phat hien ${renderTerm('Cluster', 'cluster')}`,
    sybil_protection: 'Chong Sybil',
    top10_holder_limit: `Gioi han Top 10 ${renderTerm('Holder', 'holder')}`,
    dev_hold_limit: `${renderTerm('Dev', 'dev')} hold toi da`,
    bundle_limit: `${renderTerm('Bundle', 'bundle')} toi da`,
    volume_threshold: `${renderTerm('Volume', 'volume')} toi thieu`,
    listing_age_limit: 'Gioi han tuoi niem yet',
    market_cap_check: `${renderTerm('Market Cap', 'marketCap')} toi thieu`,
    dev_risk_check: `${renderTerm('Risk Score', 'riskScore')} cua ${renderTerm('Dev', 'dev')}`,
    token_score_check: `${renderTerm('Token Score', 'tokenScore')} toi thieu`,
    bonding_curve_progress: `Tien do ${renderTerm('Bonding Curve', 'bondingCurve')}`,
    fresh_wallet_check: 'Canh bao vi moi',
    first_7_buyers_hold_limit: `Ty trong 7 ${renderTerm('Early Buyers', 'earlyBuyers')} dau`,
    early_buyer_count_check: `So luong ${renderTerm('Early Buyers', 'earlyBuyers')}`,
    preliminary_buyers: `Kiem tra ${renderTerm('Early Buyers', 'earlyBuyers')} so bo`,
    preliminary_timeout: 'Het thoi gian theo doi',
    analysis_error: 'Pipeline phan tich',
};

const RULE_PARAM_LABELS = {
    tolerancePercent: 'Do lech cho phep (%)',
    minGlobalFee: `${renderTerm('Global Fee', 'globalFee')} toi thieu (SOL)`,
    maxPercent: 'Nguong toi da (%)',
    minVol: `${renderTerm('Volume', 'volume')} toi thieu (SOL)`,
    maxMinutes: 'Tuoi toi da (phut)',
    minMarketCapSol: `${renderTerm('MC', 'marketCap')} toi thieu (SOL)`,
    maxRiskScore: `${renderTerm('Risk Score', 'riskScore')} toi da`,
    minScore: 'Diem toi thieu',
    maxProgressPercent: `${renderTerm('Bonding Curve', 'bondingCurve')} toi da (%)`,
    maxFreshCount: 'So vi moi toi da',
    minSharedFunders: 'So vi me chung toi thieu',
    minPercent: 'Nguong toi thieu (%)',
    minCount: `So ${renderTerm('Early Buyers', 'earlyBuyers')} toi thieu`,
};

function getProfileCopy(profile) {
    if (!profile) return PROFILE_COPY.custom;
    return PROFILE_COPY[profile.id] || {
        name: profile.name || PROFILE_COPY.custom.name,
        description: profile.description || PROFILE_COPY.custom.description,
    };
}

function getRuleDisplayName(ruleId, fallbackName = '') {
    return RULE_COPY[ruleId] || formatRichText(fallbackName || ruleId);
}

function getRuleTypeLabel(ruleType = '') {
    return RULE_TYPE_LABELS[ruleType] || ruleType;
}

// ── Uptime Timer ──
setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    if (uptimeEl) {
        uptimeEl.textContent = h > 0
            ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
}, 1000);

// ── Auto Reload ──
function normalizeAutoReloadSeconds(value) {
    const parsed = parseInt(value, 10);
    return [0, 5, 10, 15, 30].includes(parsed)
        ? parsed
        : DEFAULT_AUTO_RELOAD_SECONDS;
}

function updateAutoReloadCountdown() {
    if (!autoReloadCountdown) return;

    if (autoReloadSeconds === 0) {
        autoReloadCountdown.textContent = 'TẮT';
        autoReloadCountdown.classList.add('disabled');
        return;
    }

    autoReloadCountdown.classList.remove('disabled');

    if (document.hidden) {
        autoReloadCountdown.textContent = 'Dừng';
        return;
    }

    const remainingMs = Math.max(0, autoReloadDeadline - Date.now());
    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    autoReloadCountdown.textContent = `${remainingSeconds}s`;
}

function stopAutoReloadTimer() {
    if (!autoReloadTimer) return;
    clearInterval(autoReloadTimer);
    autoReloadTimer = null;
}

function startAutoReloadTimer() {
    stopAutoReloadTimer();
    autoReloadDeadline = Date.now() + autoReloadSeconds * 1000;
    updateAutoReloadCountdown();

    if (autoReloadSeconds === 0) return;

    autoReloadTimer = setInterval(() => {
        if (document.hidden) {
            updateAutoReloadCountdown();
            return;
        }

        if (Date.now() >= autoReloadDeadline) {
            location.reload();
            return;
        }

        updateAutoReloadCountdown();
    }, AUTO_RELOAD_TICK_MS);
}

function setAutoReloadInterval(seconds) {
    autoReloadSeconds = normalizeAutoReloadSeconds(seconds);

    if (autoReloadSelect) {
        autoReloadSelect.value = String(autoReloadSeconds);
    }

    window.localStorage.setItem(AUTO_RELOAD_STORAGE_KEY, String(autoReloadSeconds));

    if (autoReloadSeconds === 0) {
        stopAutoReloadTimer();
        updateAutoReloadCountdown();
        return;
    }

    startAutoReloadTimer();
}

function initAutoReload() {
    const savedSeconds = window.localStorage.getItem(AUTO_RELOAD_STORAGE_KEY);
    setAutoReloadInterval(savedSeconds ?? DEFAULT_AUTO_RELOAD_SECONDS);
}

autoReloadSelect?.addEventListener('change', (e) => {
    setAutoReloadInterval(e.target.value);
});

document.addEventListener('visibilitychange', () => {
    if (autoReloadSeconds === 0) {
        updateAutoReloadCountdown();
        return;
    }

    if (!document.hidden) {
        autoReloadDeadline = Date.now() + autoReloadSeconds * 1000;
    }

    updateAutoReloadCountdown();
});

initAutoReload();

// ═══════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════
socket.on('connect', () => {
    connectionStatus.classList.add('online');
});

socket.on('disconnect', () => {
    connectionStatus.classList.remove('online');
});

// ═══════════════════════════════════════
// SOL PRICE
// ═══════════════════════════════════════
socket.on('solPriceUpdate', (price) => {
    solPrice = price;
    if (solPriceEl) solPriceEl.textContent = `$${price.toFixed(2)}`;
});

// ═══════════════════════════════════════
// BOT STATUS
// ═══════════════════════════════════════
socket.on('botStatus', (status) => {
    if (autoBuyToggle) autoBuyToggle.checked = status.autoBuyEnabled;
    if (autoSellToggle) autoSellToggle.checked = status.autoSellEnabled;
    if (buyAmountInput) buyAmountInput.value = status.buyAmountSol;
    if (takeProfitInput) takeProfitInput.value = status.takeProfitPercent;
    if (stopLossInput) stopLossInput.value = status.stopLossPercent;
    if (maxPositionsInput) maxPositionsInput.value = status.maxPositions;
    if (dailyLossInput) dailyLossInput.value = status.dailyLossLimitSol;
    if (earlyBuyersInput) earlyBuyersInput.value = status.earlyBuyersToMonitor;
    if (minBuyersToPassInput) minBuyersToPassInput.value = status.minBuyersToPass;
    if (showAllBuyersToggle) showAllBuyersToggle.checked = status.showAllEarlyBuyers;
    if (buySlippageInput) buySlippageInput.value = status.buySlippage;
    if (sellSlippageInput) sellSlippageInput.value = status.sellSlippage;
    if (status.activeRuleProfile) {
        activeRuleProfile = status.activeRuleProfile;
        renderRuleProfiles(currentRuleProfiles, activeRuleProfile);
    }
    if (status.realWallet) {
        updateRealWallet(status.realWallet);
    }
});

// ═══════════════════════════════════════
// DAILY STATS
// ═══════════════════════════════════════
socket.on('dailyStats', (stats) => {
    if (totalScannedEl) totalScannedEl.textContent = stats.tokensScanned || 0;
    if (totalBoughtEl) totalBoughtEl.textContent = stats.tokensBought || 0;
    if (dailyPnlEl) {
        const pnl = stats.totalPnlSol || 0;
        dailyPnlEl.textContent = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL`;
        pnlChip.classList.toggle('positive', pnl >= 0);
        pnlChip.classList.toggle('negative', pnl < 0);
    }
});

// ═══════════════════════════════════════
// TOKEN FEED
// ═══════════════════════════════════════

function shortenMint(mint) {
    if (!mint) return '';
    return mint.slice(0, 6) + '...' + mint.slice(-4);
}

function getAge(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
}

function createFeedItem(token) {
    const item = document.createElement('div');
    item.className = 'feed-item';
    item.dataset.mint = token.mint;
    item.dataset.status = 'pending';
    item.dataset.timestamp = token.timestamp || Date.now();

    let statusClass = 'pending';
    let statusText = 'DANG XU LY';
    if (token.status === 'ELIGIBLE' || token.status === 'PASS') {
        statusClass = 'pass';
        statusText = 'DAT';
        item.dataset.status = 'pass';
    } else if (token.status === 'BLOCKED' || token.status === 'FAIL') {
        statusClass = 'fail';
        statusText = 'LOAI';
        item.dataset.status = 'fail';
    }

    const symbol = escapeHtml(token.symbol || '???');
    const tokenName = token.name ? escapeHtml(token.name.slice(0, 20)) : '';
    const mint = escapeHtml(token.mint || '');

    item.innerHTML = `
        <div class="feed-item-row">
            <span class="symbol">${symbol}<span class="name-dim">${tokenName ? ` / ${tokenName}` : ''}</span></span>
            <span class="feed-badge ${statusClass}">${statusText}</span>
        </div>
        <div class="meta-row">
            <span class="mint-short">${shortenMint(mint)}</span>
            <span class="age-tag" data-ts="${token.timestamp || Date.now()}">${getAge(token.timestamp || Date.now())}</span>
        </div>
    `;

    item.addEventListener('click', () => {
        selectedMint = token.mint;
        $$('.feed-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        socket.emit('getAnalysis', token.mint);
    });

    return item;
}

function addTokenToFeed(token) {
    if (feedItems.has(token.mint)) return;

    const item = createFeedItem(token);
    feedItems.set(token.mint, item);

    // Remove placeholder
    const placeholder = tokenFeed.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    tokenFeed.prepend(item);
    feedCount++;
    feedCounter.textContent = feedCount;

    applyFilter();

    // Limit feed size
    if (feedItems.size > 1000) {
        const keys = [...feedItems.keys()];
        const oldest = keys[0];
        const oldEl = feedItems.get(oldest);
        if (oldEl) oldEl.remove();
        feedItems.delete(oldest);
    }
}

function updateFeedItemStatus(mint, status) {
    const item = feedItems.get(mint);
    if (!item) return;

    const badge = item.querySelector('.feed-badge');
    if (!badge) return;

    item.dataset.status = status === 'ELIGIBLE' ? 'pass' : 'fail';

    if (status === 'ELIGIBLE') {
        badge.className = 'feed-badge pass';
        badge.textContent = 'DAT';
        // Update passed counter (deduplicate)
        if (!countedPasses.has(mint)) {
            countedPasses.add(mint);
            const current = parseInt(totalPassedEl.textContent) || 0;
            totalPassedEl.textContent = current + 1;
        }
    } else {
        badge.className = 'feed-badge fail';
        badge.textContent = 'LOAI';
    }

    applyFilter();
}

// Update ages every 10s
setInterval(() => {
    $$('.age-tag[data-ts]').forEach(el => {
        const ts = parseInt(el.dataset.ts);
        if (ts) el.textContent = getAge(ts);
    });
}, 10000);

// Initial feed load
socket.on('initialFeed', (tokens) => {
    if (!tokens || tokens.length === 0) return;
    tokenFeed.innerHTML = '';
    feedItems.clear();
    feedCount = 0;

    // Tokens come newest first, we reverse to prepend correctly
    const sorted = [...tokens].reverse();
    for (const token of sorted) {
        addTokenToFeed(token);
    }
});

// New token arrives
socket.on('newToken', (token) => {
    addTokenToFeed(token);
});

// Live price update for tokens
socket.on('tokenPriceUpdate', (data) => {
    const { mint, marketCapSol, marketCapUsd, globalFee } = data;
    const solPrice = parseFloat(document.getElementById('solPrice')?.textContent?.replace('$', '') || 150);
    const currentMcapUsd = marketCapUsd || (marketCapSol * solPrice);

    // 1. Update Detail View if open
    if (selectedMint === mint) {
        const currentMcVal = document.querySelector('.info-grid .val.yellow');
        if (currentMcVal) currentMcVal.textContent = '$' + formatNumber(currentMcapUsd);
        
        const feeVal = document.querySelector('.info-grid .val.highlight-val.yellow');
        if (feeVal) feeVal.textContent = globalFee.toFixed(4) + ' SOL';
    }

    // 2. Update Pass 24h and Top 10 items
    const rows = document.querySelectorAll(`[data-mint="${mint}"]`);
    rows.forEach(row => {
        const launchMcap = parseFloat(row.dataset.launch) || 0;
        if (launchMcap > 0) {
            const currentMultiplier = (currentMcapUsd / launchMcap).toFixed(1);
            const currentPnl = ((currentMcapUsd - launchMcap) / launchMcap * 100).toFixed(0);
            
            // Update multiplier for current
            const multSpan = row.querySelector('.multiplier.current');
            if (multSpan) multSpan.textContent = 'x' + currentMultiplier;
            
            // Update mcap line for current
            const currentValSpan = row.querySelector('.mcap-line.current-line .val');
            if (currentValSpan) {
                currentValSpan.textContent = `$${formatNumber(currentMcapUsd)} (${currentPnl >= 0 ? '+' : ''}${currentPnl}%)`;
                currentValSpan.className = `val ${currentPnl >= 0 ? 'up' : 'down'}`;
            }

            // Update Top 10 specific PnL highlight (current)
            const highlightPnl = row.querySelector('.highlight-pnl.current');
            if (highlightPnl) {
                highlightPnl.textContent = `Now: ${currentPnl >= 0 ? '+' : ''}${currentPnl}%`;
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

// ═══════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════
function handleSearch() {
    const mint = contractSearch.value.trim();
    if (mint) {
        selectedMint = mint;
        socket.emit('getAnalysis', mint);
    }
}

function requestPassedTokenInfo(tokenOrMint) {
    const mint = typeof tokenOrMint === 'string' ? tokenOrMint : tokenOrMint?.mint;
    if (!mint) return;

    selectedMint = mint;

    if (typeof tokenOrMint === 'object') {
        const launchMcapUsd = tokenOrMint.launch_mcap_usd || 0;
        const highestMcapUsd = tokenOrMint.highest_mcap_usd || launchMcapUsd;

        renderAnalysis({
            infoOnly: true,
            tokenData: {
                mint,
                name: tokenOrMint.name || 'Khong ro',
                symbol: tokenOrMint.symbol || '???',
                timestamp: tokenOrMint.timestamp || Date.now(),
                launchMcapUsd,
                highestMcapUsd,
                highestMcapTimestamp: tokenOrMint.highest_mcap_timestamp || null,
                marketCapUsd: highestMcapUsd,
                circulatingMcapUsd: highestMcapUsd,
            },
            ruleResult: {
                shouldBuy: true,
                summary: 'Thong tin token da qua loc',
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

// ═══════════════════════════════════════
// MANUAL REFRESH
// ═══════════════════════════════════════
function manualRefresh(mint) {
    const btn = $('#refreshBtn');
    if (!btn) return;

    // Visual feedback
    btn.disabled = true;
    const icon = btn.querySelector('i');
    if (icon) icon.classList.add('spinning');
    btn.querySelector('span').textContent = 'Đang làm mới...';

    socket.emit('manualRefresh', mint);

    // Safety timeout to reset button if no response
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

    // Force selectedMint so the incoming analysisResult renders for this token
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
// ANALYSIS DETAIL
// ═══════════════════════════════════════

socket.on('analysisResult', (data) => {
    const { tokenData, ruleResult, devAnalysis, tokenScore, holderStats, clusterAnalysis, earlyBuyers, earlyBuyerTrades, globalFee } = data;

    // Update feed item status
    if (tokenData?.mint && ruleResult) {
        updateFeedItemStatus(tokenData.mint, ruleResult.shouldBuy ? 'ELIGIBLE' : 'BLOCKED');
    }

    // Update scanned counter (deduplicate)
    if (tokenData?.mint && !analyzedMints.has(tokenData.mint)) {
        analyzedMints.add(tokenData.mint);
        const scanned = parseInt(totalScannedEl.textContent) || 0;
        totalScannedEl.textContent = scanned + 1;
    }

    // Only render analysis and auto-focus if this is the selected token, or if none is selected yet
    if (!selectedMint || selectedMint === tokenData?.mint) {
        // If nothing was selected before, select it now
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

// Initial scans load
socket.on('initialScans', (scans) => {
    if (!scans || scans.length === 0) return;
    // Update each feed item's status and populate dedup sets
    for (const scan of scans) {
        if (scan.mint) {
            analyzedMints.add(scan.mint);
            if (scan.action_taken === 'ELIGIBLE') {
                countedPasses.add(scan.mint);
            }
        }
        if (scan.action_taken) {
            updateFeedItemStatus(scan.mint, scan.action_taken);
        }
    }
    // Update passed counter from actual data (scanned counter is set by dailyStats from DB)
    totalPassedEl.textContent = countedPasses.size;

    // Show most recent analysis
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

function renderAnalysis(data) {
    const { tokenData, ruleResult, devAnalysis, tokenScore, holderStats, clusterAnalysis, earlyBuyers, globalFee } = data;

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

    // MCap - Axiom style: circulating market cap (excludes bonding curve/LP)
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
                <h3>${symbol} <span class="verdict-badge ${isPassed ? 'pass' : 'fail'}">${isPassed ? 'DAT' : 'LOAI'}</span></h3>
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

    // ── Market Data (Axiom style - circulating) ──
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
            <div class="section-title"><i class="fas fa-circle-info"></i> Thong tin token</div>
            <div class="info-only-actions">
                <button class="refresh-btn" id="refreshPassedInfoBtn" onclick="refreshPassedTokenInfo('${mint}')">
                    <i class="fas fa-rotate"></i>
                    <span>Cap nhat trang thai</span>
                </button>
            </div>
            <div class="info-grid">
                <div class="info-card">
                    <h4><i class="fas fa-coins"></i> Anh chup thi truong</h4>
                    <div class="info-row"><span class="label">${renderTerm('MC', 'marketCap')} luc qua loc</span><span class="val">${launchMcapUsd > 0 ? '$' + formatNumber(launchMcapUsd) : '---'}</span></div>
                    <div class="info-row"><span class="label">${renderTerm('MC', 'marketCap')} hien tai</span><span class="val yellow">${currentMcapUsd > 0 ? '$' + formatNumber(currentMcapUsd) : '---'}</span></div>
                    <div class="info-row"><span class="label">${renderTerm('MC', 'marketCap')} cao nhat</span><span class="val green">${highestMcapUsd > 0 ? '$' + formatNumber(highestMcapUsd) : '---'}</span></div>
                    <div class="info-row"><span class="label">Hieu suat</span><span class="val ${performancePct >= 0 ? 'green' : 'red'}">${performancePct >= 0 ? '+' : ''}${performancePct.toFixed(1)}%</span></div>
                </div>
                <div class="info-card">
                    <h4><i class="fas fa-wave-square"></i> Du lieu thi truong</h4>
                    <div class="info-row"><span class="label">${renderTerm('Volume', 'volume')} (24h)</span><span class="val highlight-val">${tokenData.volume > 0 ? tokenData.volume.toFixed(1) + ' SOL' : '---'}</span></div>
                    <div class="info-row"><span class="label">${renderTerm('Global Fee', 'globalFee')}</span><span class="val highlight-val yellow">${tokenData.globalFee > 0 ? tokenData.globalFee.toFixed(4) + ' SOL' : '---'}</span></div>
                    <div class="info-row"><span class="label">${renderTerm('Holder', 'holder')}</span><span class="val highlight-val green">${holderStats?.realHolderCount || '---'}</span></div>
                    <div class="info-row"><span class="label">Cap nhat luc</span><span class="val">${refreshedAt}</span></div>
                </div>
                <div class="info-card">
                    <h4><i class="fas fa-clock"></i> Dong thoi gian</h4>
                    <div class="info-row"><span class="label">Qua loc luc</span><span class="val">${passedAt}</span></div>
                    <div class="info-row"><span class="label">${renderTerm('ATH', 'ath')} luc</span><span class="val">${highestAt}</span></div>
                    <div class="info-row"><span class="label">${renderTerm('Deployer', 'deployer')}</span><span class="val" style="font-size: 10px;">${deployer || '---'}</span></div>
                </div>
            </div>
            <div style="font-size: 10px; color: var(--text-muted); text-align: right; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border);">
                Token da vuot qua bo loc. Nhan "Cap nhat trang thai" de lam moi du lieu.
            </div>
        `;

        html += `</div>`;
        liveAnalysis.innerHTML = html;
        hydrateTermAnnotations(liveAnalysis);
        return;
    }

    // ── Bonding Curve Progress ──
    if (bondingProgress > 0) {
        html += `
            <div class="progress-bar-container">
                <div class="progress-label">
                    <span>${renderTerm('Bonding Curve', 'bondingCurve')}</span>
                    <span>${bondingProgress.toFixed(1)}%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill ${bondingProgress > 70 ? 'high' : ''}" style="width: ${Math.min(bondingProgress, 100)}%"></div>
                </div>
            </div>
        `;
    }

    // ── Verdict ──
    html += `
        <div class="verdict-box ${isPassed ? 'pass' : 'fail'}">
            <i class="fas ${isPassed ? 'fa-check-double' : 'fa-shield-alt'}"></i>
            <span>${formatRichText(ruleResult.summary || (isPassed ? 'Tat ca quy tac deu dat.' : 'Bi chan boi bo quy tac.'))}</span>

            <button class="refresh-btn" id="refreshBtn" onclick="manualRefresh('${mint}')">
                <i class="fas fa-sync-alt"></i>
                <span>Cap nhat trang thai</span>
            </button>
        </div>
    `;

    // ── Rule Results ──
    if (ruleResult.results && ruleResult.results.length > 0) {
        html += `<div class="section-title"><i class="fas fa-list-check"></i> Ket qua bo quy tac (${ruleResult.results.filter((r) => r.passed).length}/${ruleResult.results.length} dat)</div>`;
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
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">(Ban ghi cu, chua co du lieu quy tac chi tiet)</div>
            </div>
        `;
    }

    // ── Dev & Token Score Info ──
    const devData = devAnalysis || {};
    const tsData = (typeof tokenScore === 'object') ? tokenScore : {};

    if (devData.address || tsData.totalScore !== undefined || data.devRiskScore !== undefined) {
        html += `<div class="info-grid">`;

        // Dev Analysis Card
        html += `<div class="info-card"><h4><i class="fas fa-user-shield"></i> Phan tich ${renderTerm('Dev', 'dev')}</h4>`;
        if (devData.address) {
            const riskColor = devData.riskScore >= 70 ? 'red' : devData.riskScore >= 40 ? 'yellow' : 'green';
            const riskLevel = escapeHtml(devData.riskLevel || '---');
            html += `
                <div class="info-row"><span class="label">Dia chi</span><span class="val" style="font-size: 10px;">${escapeHtml(devData.address)}</span></div>
                <div class="info-row"><span class="label">${renderTerm('Risk Score', 'riskScore')}</span><span class="val ${riskColor}">${devData.riskScore}/100 (${riskLevel})</span></div>
                <div class="info-row"><span class="label">So du</span><span class="val">${(devData.balanceSol || 0).toFixed(3)} SOL</span></div>
                <div class="info-row"><span class="label">So giao dich</span><span class="val">${devData.totalTxCount || 0}</span></div>
                <div class="info-row"><span class="label">Token da tao</span><span class="val">${devData.tokensDeployed || 0}</span></div>
                <div class="info-row"><span class="label">Tuoi vi</span><span class="val">${devData.walletAge || 0} ngay</span></div>
            `;
        } else if (data.devRiskScore !== undefined) {
            html += `<div class="info-row"><span class="label">${renderTerm('Risk Score', 'riskScore')}</span><span class="val">${data.devRiskScore}/100</span></div>`;
        } else {
            html += `<div style="color: var(--text-muted); font-size: 11px;">Chua co du lieu</div>`;
        }
        html += `</div>`;

        // Token Score Card
        html += `<div class="info-card"><h4><i class="fas fa-star"></i> ${renderTerm('Token Score', 'tokenScore')}</h4>`;
        if (tsData.totalScore !== undefined) {
            const scoreColor = tsData.totalScore >= 70 ? 'green' : tsData.totalScore >= 45 ? 'yellow' : 'red';
            const verdict = escapeHtml(tsData.verdict || '---');
            html += `
                <div class="info-row"><span class="label">Tong diem</span><span class="val ${scoreColor}">${tsData.totalScore}/100 (${verdict})</span></div>
                <div class="info-row"><span class="label">${renderTerm('Metadata', 'metadata')}</span><span class="val">${tsData.metadataScore || 0}</span></div>
                <div class="info-row"><span class="label">${renderTerm('Bonding Curve', 'bondingCurve')}</span><span class="val">${tsData.bondingCurveScore || 0}</span></div>
                <div class="info-row"><span class="label">${renderTerm('URI Score', 'uriScore')}</span><span class="val">${tsData.uriScore || 0}</span></div>
            `;
        } else if (data.tokenScore !== undefined && typeof data.tokenScore === 'number') {
            html += `<div class="info-row"><span class="label">Diem</span><span class="val">${data.tokenScore}/100</span></div>`;
        } else {
            html += `<div style="color: var(--text-muted); font-size: 11px;">Chua co du lieu</div>`;
        }
        html += `</div>`;

        html += `</div>`; // close info-grid
    }

    // ── Holder Stats ──
    if (holderStats) {
        html += `<div class="section-title"><i class="fas fa-users"></i> Phan bo ${renderTerm('Holder', 'holder')}</div>`;
        html += `<div class="info-grid">`;

        html += `<div class="info-card"><h4><i class="fas fa-chart-pie"></i> Do tap trung (% cung, tru pool)</h4>`;
        const t10Color = holderStats.top10Percent > 30 ? 'red' : holderStats.top10Percent > 20 ? 'yellow' : 'green';
        const devColor = holderStats.devHoldPercent > 20 ? 'red' : holderStats.devHoldPercent > 10 ? 'yellow' : 'green';
        const bundleColor = holderStats.bundleHoldPercent > 20 ? 'red' : 'green';
        const earlyBuyerColor = holderStats.earlyBuyerHoldPercent > 20 ? 'red' : 'green';
        html += `
            <div class="info-row"><span class="label">${renderTerm('Holder', 'holder')} thuc</span><span class="val">${holderStats.realHolderCount ?? 0}${typeof holderStats.filteredFunctionalCount === 'number' ? ` | Loc: ${holderStats.filteredFunctionalCount}` : ''}</span></div>
            <div class="info-row"><span class="label">Top 10</span><span class="val ${t10Color}">${holderStats.top10Percent?.toFixed(1)}%${typeof holderStats.top10OwnersPercent === 'number' ? ` | Vi so huu: ${holderStats.top10OwnersPercent.toFixed(1)}%` : ''}</span></div>
            <div class="info-row"><span class="label">${renderTerm('Dev', 'dev')}</span><span class="val ${devColor}">${holderStats.devHoldPercent?.toFixed(1)}%</span></div>
            <div class="info-row"><span class="label">${renderTerm('Bundle', 'bundle')}</span><span class="val ${bundleColor}">${holderStats.bundleHoldPercent?.toFixed(1)}%</span></div>
            <div class="info-row"><span class="label">${renderTerm('Early Buyers', 'earlyBuyers')}</span><span class="val ${earlyBuyerColor}">${holderStats.earlyBuyerHoldPercent?.toFixed(1)}%</span></div>
        `;
        html += `</div>`;

        // Cluster info
        html += `<div class="info-card"><h4><i class="fas fa-project-diagram"></i> Phan tich ${renderTerm('Cluster', 'cluster')}</h4>`;
        if (clusterAnalysis) {
            const clRisk = clusterAnalysis.riskLevel;
            const clColor = clRisk === 'HIGH' ? 'red' : clRisk === 'MEDIUM' ? 'yellow' : 'green';
            const sharedCount = clusterAnalysis.sharedFunders?.length || 0;
            const isWinnerSignal = sharedCount >= 3;
            const clRiskLabel = clRisk === 'HIGH'
                ? 'CAO'
                : clRisk === 'MEDIUM'
                    ? 'TRUNG BINH'
                    : 'THAP';
            
            html += `
                <div class="info-row"><span class="label">Tin hieu thang</span><span class="val ${isWinnerSignal ? 'green' : 'yellow'}" style="font-weight:700">${isWinnerSignal ? 'MANH (x5+)' : 'CAN THEO DOI'}</span></div>
                <div class="info-row"><span class="label">Co cluster</span><span class="val ${clusterAnalysis.isLikelyCluster ? 'red' : 'green'}">${clusterAnalysis.isLikelyCluster ? 'CO' : 'KHONG'}</span></div>
                <div class="info-row"><span class="label">Muc rui ro</span><span class="val ${clColor}">${clRiskLabel}</span></div>
                <div class="info-row"><span class="label">Vi me chung</span><span class="val" style="font-weight:700">${sharedCount}</span></div>
                <div class="info-row"><span class="label">${renderTerm('White Wallet', 'whiteWallet')}</span><span class="val">${clusterAnalysis.whiteWalletCount || 0}/${clusterAnalysis.walletCount || 0}</span></div>
            `;
        } else {
            html += `<div style="color: var(--text-muted); font-size: 11px;">Chua co du lieu cluster</div>`;
        }
        html += `</div>`;

        html += `</div>`; // close info-grid
    }

    // ── Early Buyers Table ──
    if (earlyBuyers && earlyBuyers.length > 0) {
        html += `<div class="section-title"><i class="fas fa-wallet"></i> ${renderTerm('Early Buyers', 'earlyBuyers')} (${earlyBuyers.length})</div>`;
        html += `
            <table class="buyers-table">
                <thead>
                    <tr>
                        <th>Vi</th>
                        <th>Mua</th>
                        <th>Loai</th>
                        <th>So du</th>
                        <th>Tuoi</th>
                        <th>TXs</th>
                        <th>Nguon</th>
                    </tr>
                </thead>
                <tbody>
        `;
        for (const buyer of earlyBuyers) {
            const tagClass = buyer.isWhiteWallet ? 'white' : 'old';
            const tagText = buyer.isWhiteWallet ? 'MOI' : 'CU';
            const source = buyer.sourceOfFunds?.hasCEXFunding ? 'CEX' :
                (buyer.fundingWallets?.length > 0 ? 'Vi' : '---');
            html += `
                <tr>
                    <td style="font-size: 10px; font-family: 'JetBrains Mono', monospace;">${escapeHtml(buyer.address)}</td>
                    <td style="font-weight: 700; color: var(--green); white-space: nowrap;">${(buyer.solAmount || 0).toFixed(2)} SOL</td>
                    <td><span class="wallet-tag ${tagClass}">${tagText}</span></td>
                    <td>${(buyer.balance || 0).toFixed(3)}</td>
                    <td>${buyer.walletAgeDays || 0}d</td>
                    <td>${buyer.txCount || 0}</td>
                    <td>${source}</td>
                </tr>
            `;
        }
        html += `</tbody></table>`;
    }

    // ── Footer ──
    html += `
        <div style="font-size: 10px; color: var(--text-muted); text-align: right; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border);">
            Phan tich luc: ${timeStr} | ${renderTerm('Deployer', 'deployer')}: ${deployer || '---'}
        </div>
    `;

    html += `</div>`; // close detail-card

    liveAnalysis.innerHTML = html;
    hydrateTermAnnotations(liveAnalysis);
}

// ═══════════════════════════════════════
// PASSED TOKENS 24H
// ═══════════════════════════════════════
socket.on('passedTokensUpdate', (tokens) => {
    if (!tokens || tokens.length === 0) {
        passedTokensContainer.innerHTML = '<div class="placeholder-text">Chưa có token qua lọc trong 24h</div>';
        if (totalPassedEl) totalPassedEl.textContent = 0;
        return;
    }

    // Sync countedPasses set from authoritative DB data
    for (const token of tokens) {
        if (token.mint) countedPasses.add(token.mint);
    }
    // Update passed count
    if (totalPassedEl) totalPassedEl.textContent = tokens.length;

    passedTokensContainer.innerHTML = '';
    for (const token of tokens) {
        const passTime = token.timestamp ? new Date(token.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '---';
        const launchMcap = token.launch_mcap_usd || 1;
        const highMcap = token.highest_mcap_usd || launchMcap;
        const currentMcap = token.current_mcap_usd || 0;
        
        // PnL is always based on PEAK (highest_mcap_usd) — never goes down
        const peakMultiplier = (highMcap / launchMcap).toFixed(1);
        const peakPnl = ((highMcap - launchMcap) / launchMcap * 100).toFixed(0);
        
        // Current price
        const currentMultiplier = currentMcap > 0 ? (currentMcap / launchMcap).toFixed(1) : peakMultiplier;
        const currentPnl = currentMcap > 0 ? ((currentMcap - launchMcap) / launchMcap * 100).toFixed(0) : null;

        const row = document.createElement('div');
        row.className = 'passed-row';
        row.dataset.mint = token.mint;
        row.dataset.launch = launchMcap;
        const isLive = token.current_mcap_usd > 0;
        const statusBadge = isLive ? `<span class="mini-badge live">LIVE</span>` : `<span class="mini-badge token-passed">PASSED</span>`;

        row.innerHTML = `
            <div class="passed-row-header">
                <span class="sym">${token.symbol} <span class="pass-time">${passTime}</span> ${statusBadge}</span>
                <span class="multiplier peak up">x${peakMultiplier}</span>
            </div>
            <div class="mcap-line launch-line">
                <span class="label">Pass MC:</span>
                <span class="val yellow">$${formatNumber(launchMcap)} ${token.launch_mcap_sol ? `(${token.launch_mcap_sol.toFixed(2)} SOL)` : ''}</span>
            </div>
            <div class="mcap-line peak-line">
                <span class="label">ATH MC:</span>
                <span class="val up">$${formatNumber(highMcap)} (+${peakPnl}%)</span>
            </div>
            ${currentMcap > 0 ? `
            <div class="mcap-line current-line">
                <span class="label">Current:</span>
                <span class="val ${currentPnl >= 0 ? 'up' : 'down'}">$${formatNumber(currentMcap)} (${currentPnl >= 0 ? '+' : ''}${currentPnl}%)</span>
            </div>` : ''}
        `;

        row.addEventListener('click', () => {
            requestPassedTokenInfo(token);
        });

        passedTokensContainer.appendChild(row);
    }
});

// ═══════════════════════════════════════
// TOP 10 PNL 24H
// ═══════════════════════════════════════
socket.on('topPnLUpdate', (tokens) => {
    if (!tokens || tokens.length === 0) {
        if(top10Container) top10Container.innerHTML = '<div class="placeholder-text">Chưa đủ dữ liệu để tính Top 10</div>';
        return;
    }

    if(top10Container) top10Container.innerHTML = '';
    
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
        row.className = 'top10-row passed-row'; // reusing some structural styles
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
                    <div class="highlight-pnl current ${currentPnlPercent >= 0 ? 'up' : 'down'}" style="font-size: 9px; margin-top: 2px;">Now: ${currentPnlPercent >= 0 ? '+' : ''}${currentPnlPercent.toFixed(0)}%</div>
                </div>
            </div>
            <div class="mcap-line peak-line">
                <span class="label">ATH MC:</span>
                <span class="val green">$${formatNumber(highMcap)} (x${peakMultiplier})</span>
            </div>
        `;

        row.addEventListener('click', () => {
            requestPassedTokenInfo(token);
        });

        top10Container.appendChild(row);
    });
});

// ═══════════════════════════════════════
// WIN RATE 1D / 3D / 7D
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
        el.title = `Win ${p.toUpperCase()}: ${wins}W / ${losses}L (${total} total) | Avg PnL (ATH): ${avgPnlPercent.toFixed(1)}% | ≥x1.1 = Win, ≤x1.0 = Loss`;
        // Color coding
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

    tradeHistoryContainer.innerHTML = '';
    for (const trade of trades) {
        const isBuy = trade.action === 'BUY';
        const time = new Date(trade.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        const pnl = trade.pnl_percent || 0;

        const row = document.createElement('div');
        row.className = 'trade-row';
        row.innerHTML = `
            <div class="trade-icon ${isBuy ? 'buy' : 'sell'}">${isBuy ? 'B' : 'S'}</div>
            <div class="trade-info">
                <div class="sym">${trade.token_symbol || shortenMint(trade.mint)}</div>
                <div class="time">${time}</div>
            </div>
            <div class="trade-amount">
                <div class="sol">${trade.sol_amount?.toFixed(3) || '0'} SOL</div>
                ${!isBuy && pnl !== 0 ? `<div class="pnl ${pnl > 0 ? 'green' : 'red'}">${pnl > 0 ? '+' : ''}${pnl.toFixed(1)}%</div>` : ''}
            </div>
        `;
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

    container.innerHTML = '';
    positions.forEach((pos) => {
        const row = document.createElement('div');
        const pnl = pos.currentPnlPercent || 0;
        row.className = 'trade-row position-row';
        row.dataset.mint = pos.mint;
        
        row.innerHTML = `
            <div class="trade-icon buy">R</div>
            <div class="trade-info">
                <div class="sym">${pos.symbol || shortenMint(pos.mint)}</div>
                <div class="time">Mcap Vào: ${(pos.entryMarketCapSol || 0).toFixed(2)} SOL</div>
            </div>
            <div class="trade-amount">
                <div class="sol">${(pos.buyAmountSol || 0).toFixed(3)} SOL</div>
                <div class="pnl ${pnl >= 0 ? 'green' : 'red'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%</div>
            </div>
        `;
        
        row.addEventListener('click', () => {
            selectedMint = pos.mint;
            socket.emit('getAnalysis', pos.mint);
        });
        
        container.appendChild(row);
    });
}

// ═══════════════════════════════════════
// RULES
// ═══════════════════════════════════════
function renderRuleProfiles(profiles = [], activeProfileId = 'custom') {
    if (!ruleProfilesContainer) return;

    currentRuleProfiles = profiles;
    activeRuleProfile = activeProfileId || 'custom';

    const activeProfile = profiles.find((profile) => profile.id === activeRuleProfile);

    if (activeRuleProfileName) {
        activeRuleProfileName.textContent = activeProfile ? activeProfile.name : 'Custom';
    }

    if (activeRuleProfileBadge) {
        activeRuleProfileBadge.textContent = activeProfile ? activeProfile.id : 'custom';
        activeRuleProfileBadge.classList.toggle('active', activeRuleProfile !== 'custom');
    }

    if (activeRuleProfileHint) {
        activeRuleProfileHint.textContent = activeProfile
            ? activeProfile.description
            : 'Preset đã bị vượt ra ngoài vì có chỉnh tay trên rules hoặc monitoring.';
    }

    ruleProfilesContainer.innerHTML = '';

    const profileList = [...profiles];
    if (!profileList.some((profile) => profile.id === 'custom')) {
        profileList.push({
            id: 'custom',
            name: 'Custom',
            description: 'Trạng thái hiện tại sau khi chỉnh tay. Áp lại preset để quay về cấu hình chuẩn.',
        });
    }

    for (const profile of profileList) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `profile-btn${profile.id === activeRuleProfile ? ' active' : ''}${profile.id === 'custom' ? ' custom' : ''}`;
        btn.disabled = profile.id === 'custom';
        btn.innerHTML = `
            <span class="profile-btn-title">${profile.name}</span>
            <span class="profile-btn-id">${profile.id}</span>
            <span class="profile-btn-desc">${profile.description}</span>
        `;

        if (profile.id !== 'custom') {
            btn.addEventListener('click', () => {
                socket.emit('applyRuleProfile', profile.id);
            });
        }

        ruleProfilesContainer.appendChild(btn);
    }
}

socket.on('ruleProfiles', (payload) => {
    renderRuleProfiles(payload?.profiles || [], payload?.activeRuleProfile || 'custom');
});

socket.on('rulesList', (rules) => {
    rulesContainer.innerHTML = '';

    const paramLabels = {
        tolerancePercent: 'Do lech (%)',
        minGlobalFee: `${renderTerm('Global Fee', 'globalFee')} toi thieu (SOL)`,
        maxPercent: 'Toi da (%)',
        minVol: `${renderTerm('Volume', 'volume')} toi thieu`,
        maxMinutes: 'Phut toi da',
        minMarketCapSol: `${renderTerm('MC', 'marketCap')} toi thieu`,
        maxRiskScore: `${renderTerm('Risk Score', 'riskScore')} toi da`,
        minScore: 'Diem toi thieu',
        maxProgressPercent: `${renderTerm('Bonding Curve', 'bondingCurve')} toi da (%)`,
        maxFreshCount: 'So vi moi toi da',
    };

    for (const rule of rules) {
        const div = document.createElement('div');
        div.className = 'rule-switch';
        const numericParams = Object.entries(rule)
            .filter(([key, value]) => typeof value === 'number' && Number.isFinite(value))
            .map(([key, value]) => ({ key, value }));

        div.innerHTML = `
            <div class="rule-switch-info">
                <span class="rule-switch-name">${rule.name}</span>
                <span class="rule-switch-type ${rule.type.toLowerCase()}">${rule.type}</span>
                ${numericParams.length > 0 ? `
                    <div class="rule-param-list">
                        ${numericParams.map((param) => `
                            <label class="rule-param-item">
                                <span>${paramLabels[param.key] || param.key}</span>
                                <input
                                    type="number"
                                    class="config-input rule-param-input"
                                    data-rule-id="${rule.id}"
                                    data-param="${param.key}"
                                    value="${param.value}"
                                    step="${Number.isInteger(param.value) ? '1' : '0.1'}"
                                >
                            </label>
                        `).join('')}
                    </div>
                ` : ''}
            </div>
            <label class="switch">
                <input type="checkbox" id="rule_${rule.id}" ${rule.enabled ? 'checked' : ''}>
                <span class="slider"></span>
            </label>
        `;
        rulesContainer.appendChild(div);

        div.querySelector(`#rule_${rule.id}`).addEventListener('change', (e) => {
            socket.emit('toggleRule', { ruleId: rule.id, enabled: e.target.checked });
        });

        div.querySelectorAll('.rule-param-input').forEach((input) => {
            input.addEventListener('change', (e) => {
                socket.emit('updateRuleParam', {
                    ruleId: e.target.dataset.ruleId,
                    param: e.target.dataset.param,
                    value: e.target.value,
                });
            });
        });
    }
});

// ═══════════════════════════════════════
// CONTROLS
// ═══════════════════════════════════════
autoBuyToggle?.addEventListener('change', (e) => {
    socket.emit('updateAutoBuy', e.target.checked);
});

autoSellToggle?.addEventListener('change', (e) => {
    socket.emit('updateAutoSell', e.target.checked);
});

buyAmountInput?.addEventListener('change', (e) => {
    socket.emit('updateBuyAmount', e.target.value);
});

takeProfitInput?.addEventListener('change', (e) => {
    socket.emit('updateTradingSetting', { key: 'takeProfitPercent', value: e.target.value });
});

stopLossInput?.addEventListener('change', (e) => {
    socket.emit('updateTradingSetting', { key: 'stopLossPercent', value: e.target.value });
});

maxPositionsInput?.addEventListener('change', (e) => {
    socket.emit('updateTradingSetting', { key: 'maxConcurrentPositions', value: e.target.value });
});

dailyLossInput?.addEventListener('change', (e) => {
    socket.emit('updateTradingSetting', { key: 'dailyLossLimitSol', value: e.target.value });
});

earlyBuyersInput?.addEventListener('change', (e) => {
    socket.emit('updateTradingSetting', { key: 'earlyBuyersToMonitor', value: e.target.value });
});

$('#btnSyncPositions')?.addEventListener('click', () => {
    const icon = $('#btnSyncPositions i');
    if (icon) icon.classList.add('fa-spin');
    socket.emit('manualSyncPositions');
    setTimeout(() => icon && icon.classList.remove('fa-spin'), 2000);
});

$('#refreshBalanceBtn')?.addEventListener('click', () => {
    const icon = $('#refreshBalanceBtn i');
    if (icon) icon.classList.add('fa-spin');
    socket.emit('manualSyncWallet');
    setTimeout(() => icon && icon.classList.remove('fa-spin'), 2000);
});

// ═══════════════════════════════════════
// CONTROL PANEL TABS
// ═══════════════════════════════════════
$$('.ctrl-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        $$('.ctrl-tab').forEach(t => t.classList.remove('active'));
        $$('.ctrl-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = $(`#panel-${tab.dataset.panel}`);
        if (panel) panel.classList.add('active');
    });
});

// ═══════════════════════════════════════
// TOP 10 PERIOD TOGGLE
// ═══════════════════════════════════════
$$('.period-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        $$('.period-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        const period = e.target.dataset.period;
        socket.emit('requestTop10', period);
    });
});

// ═══════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════
function formatNumber(num) {
    if (!num || num === 0) return '0';
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
    return num.toFixed(0);
}

// Event Listener for min buyers
if (minBuyersToPassInput) {
    minBuyersToPassInput.addEventListener('change', function() {
        if (this.value >= 1) {
            socket.emit('updateTradingSetting', { key: 'minBuyersToPass', value: this.value });
        }
    });
}

// Event Listener for show all early buyers toggle
if (showAllBuyersToggle) {
    showAllBuyersToggle.addEventListener('change', function() {
        socket.emit('updateTradingSetting', { key: 'showAllEarlyBuyers', value: this.checked });
    });
}

// Event Listener for buy slippage
if (buySlippageInput) {
    buySlippageInput.addEventListener('change', function() {
        if (this.value >= 1) {
            socket.emit('updateTradingSetting', { key: 'buySlippage', value: this.value });
        }
    });
}

// Event Listener for sell slippage
if (sellSlippageInput) {
    sellSlippageInput.addEventListener('change', function() {
        if (this.value >= 1) {
            socket.emit('updateTradingSetting', { key: 'sellSlippage', value: this.value });
        }
    });
}
