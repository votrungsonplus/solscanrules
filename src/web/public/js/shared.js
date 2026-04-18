/* ═══════════════════════════════════════════════════════════
   SCAN SOL BOT — shared.js
   DOM refs, state, utils, dictionaries, core socket events
   ═══════════════════════════════════════════════════════════ */

const socket = io();

// ── DOM helpers ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── DOM refs ──
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

// ── Constants ──
const AUTO_RELOAD_STORAGE_KEY = 'scan-sol-bot:auto-reload-seconds';
const DEFAULT_AUTO_RELOAD_SECONDS = 30;
const AUTO_RELOAD_TICK_MS = 250;
const MINT_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SEARCH_TIMEOUT_MS = 20000;

// ── State ──
let feedItems = new Map(); // mint -> element
let currentFilter = 'all';
let feedCount = 0;
let startTime = Date.now();
let solPrice = 0;
let analyzedMints = new Set();
let countedPasses = new Set();
let selectedMint = null;
let currentRuleProfiles = [];
let activeRuleProfile = 'custom';
let autoReloadSeconds = DEFAULT_AUTO_RELOAD_SECONDS;
let autoReloadDeadline = Date.now() + DEFAULT_AUTO_RELOAD_SECONDS * 1000;
let autoReloadTimer = null;
let _searchTimeoutId = null;
let _searchActiveMint = null;

// ── Dictionaries ──
const TERM_TOOLTIPS = {
    pnl: 'Profit & Loss — Lợi hoặc lỗ của giao dịch hay danh mục.',
    marketCap: 'Market Cap — Vốn hóa thị trường của token.',
    ath: 'All-Time High — Mức cao nhất token đã đạt được.',
    volume: 'Volume — Khối lượng giao dịch.',
    globalFee: 'Tổng phí giao dịch, thường xấp xỉ Volume × 1%.',
    bondingCurve: 'Bonding Curve — Tiến độ đường cong giá trên pump.fun; 100% là lên DEX.',
    riskScore: 'Risk Score — Điểm đánh giá mức độ rủi ro.',
    tokenScore: 'Token Score — Điểm đánh giá chất lượng token.',
    metadata: 'Metadata — Thông tin mô tả của token.',
    uriScore: 'URI Score — Điểm đánh giá đường dẫn metadata.',
    dev: 'Dev — Ví deployer hoặc người tạo token.',
    deployer: 'Deployer — Ví tạo token.',
    whiteWallet: 'White Wallet — Ví mới: tuổi < 10 giờ và < 5 giao dịch (định nghĩa thống nhất).',
    cex: 'CEX — Sàn giao dịch tập trung (Binance, OKX, v.v.).',
    cluster: 'Cluster — Nhóm ví có liên hệ nguồn vốn hoặc hành vi.',
    bundle: 'Bundle — Cụm lệnh/nhóm ví đi cùng nhau.',
    earlyBuyers: 'Early Buyers — Các ví mua trong những giao dịch đầu tiên của token.',
    holder: 'Holder — Ví đang nắm giữ token.',
    mint: 'Mint — Địa chỉ token trên blockchain Solana.',
    mcCirc: 'MC lưu hành — Vốn hóa tính trên lượng cung đang lưu hành.',
    liveStatus: 'LIVE — Đang có dữ liệu thị trường mới và tiếp tục được cập nhật.',
    autoBuy: 'Auto-Buy — Tự động mua khi token vượt qua bộ lọc quy tắc.',
    autoSell: 'Auto-Sell — Tự động bán khi chạm Take Profit, Stop Loss hoặc phát hiện rug.',
    slippage: 'Slippage — Độ trượt giá chấp nhận khi khớp lệnh.',
    takeProfit: 'Take Profit — Ngưỡng lợi nhuận để tự động chốt lời.',
    stopLoss: 'Stop Loss — Ngưỡng lỗ tối đa để tự động cắt lỗ.',
    sniper: 'Sniper — Mua/bán thủ công tức thì theo địa chỉ mint.',
    jitoBundle: 'Jito Bundle — Cách gửi giao dịch qua mạng Jito để tăng khả năng lệnh được vào block và giảm front-run.',
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
        name: 'Gắt - Logic hiện tại',
        description: 'Preset chặt nhất, bám sát logic hiện tại để ưu tiên lọc sạch.',
    },
    balanced_backup3: {
        name: 'Cân bằng - Backup3',
        description: 'Preset cân bằng, gần với backup3 và là điểm giữa để so sánh các chiến lược.',
    },
    loose_backup2: {
        name: 'Thoáng - Backup2',
        description: 'Preset dễ thoáng hơn để tăng số kèo, gần với tinh thần backup2.',
    },
    custom: {
        name: 'Tùy chỉnh',
        description: 'Trạng thái hiện tại sau khi chỉnh tay. Áp lại preset để quay về cấu hình chuẩn.',
    },
};

const RULE_TYPE_LABELS = {
    REQUIRE: 'BẮT BUỘC',
    BLOCK: 'CHẶN',
    ALERT: 'CẢNH BÁO',
    INFO: 'TÍN HIỆU',
    'PRE-SCAN': 'SƠ BỘ',
};

const RULE_COPY = {
    white_wallet_from_deployer: `${renderTerm('White Wallet', 'whiteWallet')} từ ${renderTerm('Deployer', 'deployer')}`,
    white_wallet_from_cex: `${renderTerm('White Wallet', 'whiteWallet')} từ ${renderTerm('CEX', 'cex')}`,
    same_buy_amount: 'Phát hiện mua cùng lượng',
    global_fee_threshold: `${renderTerm('Global Fee', 'globalFee')} tối thiểu`,
    cluster_detection: `Phát hiện ${renderTerm('Cluster', 'cluster')}`,
    sybil_protection: 'Chống Sybil',
    top10_holder_limit: `Giới hạn Top 10 ${renderTerm('Holder', 'holder')}`,
    dev_hold_limit: `${renderTerm('Dev', 'dev')} hold tối đa`,
    bundle_limit: `${renderTerm('Bundle', 'bundle')} tối đa`,
    volume_threshold: `${renderTerm('Volume', 'volume')} tối thiểu`,
    listing_age_limit: 'Giới hạn tuổi niêm yết',
    market_cap_check: `${renderTerm('Market Cap', 'marketCap')} tối thiểu`,
    dev_risk_check: `${renderTerm('Risk Score', 'riskScore')} của ${renderTerm('Dev', 'dev')}`,
    token_score_check: `${renderTerm('Token Score', 'tokenScore')} tối thiểu`,
    bonding_curve_progress: `Tiến độ ${renderTerm('Bonding Curve', 'bondingCurve')}`,
    new_wallet_accumulation: 'Tích trữ ví mới',
    first_7_buyers_hold_limit: `Tỷ trọng 7 ${renderTerm('Early Buyers', 'earlyBuyers')} đầu`,
    early_buyer_count_check: `Số lượng ${renderTerm('Early Buyers', 'earlyBuyers')}`,
    new_wallet_total_hold_limit: 'Tổng % cung của ví mới (cuối)',
    preliminary_buyers: `Kiểm tra ${renderTerm('Early Buyers', 'earlyBuyers')} sơ bộ`,
    preliminary_timeout: 'Hết thời gian theo dõi',
    analysis_error: 'Pipeline phân tích',
};

const RULE_PARAM_LABELS = {
    tolerancePercent: 'Độ lệch cho phép (%)',
    minGlobalFee: `${renderTerm('Global Fee', 'globalFee')} tối thiểu (SOL)`,
    maxPercent: 'Ngưỡng tối đa (%)',
    minVol: `${renderTerm('Volume', 'volume')} tối thiểu (SOL)`,
    maxMinutes: 'Tuổi tối đa (phút)',
    minMarketCapSol: `${renderTerm('MC', 'marketCap')} tối thiểu (SOL)`,
    maxRiskScore: `${renderTerm('Risk Score', 'riskScore')} tối đa`,
    minScore: 'Điểm tối thiểu',
    maxProgressPercent: `${renderTerm('Bonding Curve', 'bondingCurve')} tối đa (%)`,
    checkFirstXBuyers: 'Số ví đầu cần kiểm tra (X)',
    maxAccumulationPercent: 'Ngưỡng % cung tối đa (Y)',
    minSharedFunders: 'Số ví mẹ chung tối thiểu',
    minPercent: 'Ngưỡng tối thiểu (%)',
    minCount: `Số ${renderTerm('Early Buyers', 'earlyBuyers')} tối thiểu`,
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

// ── Generic utils ──
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

function formatNumber(num) {
    if (!num || num === 0) return '0';
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
    return num.toFixed(0);
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

// Age tick — updates .age-tag elements every 10s
setInterval(() => {
    $$('.age-tag[data-ts]').forEach(el => {
        const ts = parseInt(el.dataset.ts);
        if (ts) el.textContent = getAge(ts);
    });
}, 10000);

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
    const prevPrice = solPrice;
    solPrice = price;
    if (solPriceEl) {
        solPriceEl.textContent = `$${price.toFixed(2)}`;
        if (prevPrice > 0 && prevPrice !== price) {
            const flashClass = price > prevPrice ? 'flash-green' : 'flash-red';
            solPriceEl.classList.add(flashClass);
            setTimeout(() => solPriceEl.classList.remove(flashClass), 1500);
        }
    }
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
