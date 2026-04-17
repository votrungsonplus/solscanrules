/* ═══════════════════════════════════════════════════════════
   SCAN SOL BOT — controls.js
   Rule profiles, rule list, trading settings, tabs, period toggle
   ═══════════════════════════════════════════════════════════ */

// ═══════════════════════════════════════
// RULE PROFILES
// ═══════════════════════════════════════
function renderRuleProfiles(profiles = [], activeProfileId = 'custom') {
    if (!ruleProfilesContainer) return;

    currentRuleProfiles = profiles;
    activeRuleProfile = activeProfileId || 'custom';

    const activeProfile = profiles.find((profile) => profile.id === activeRuleProfile);

    if (activeRuleProfileName) {
        activeRuleProfileName.textContent = activeProfile ? activeProfile.name : 'Tùy chỉnh';
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
            name: 'Tùy chỉnh',
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

// ═══════════════════════════════════════
// RULES LIST (toggle + numeric params)
// ═══════════════════════════════════════
socket.on('rulesList', (rules) => {
    rulesContainer.innerHTML = '';

    const paramLabels = RULE_PARAM_LABELS;

    for (const rule of rules) {
        const div = document.createElement('div');
        div.className = 'rule-switch';
        const numericParams = Object.entries(rule)
            .filter(([key, value]) => typeof value === 'number' && Number.isFinite(value))
            .map(([key, value]) => ({ key, value }));

        div.innerHTML = `
            <div class="rule-switch-info">
                <span class="rule-switch-name">${getRuleDisplayName(rule.id, rule.name)}</span>
                <span class="rule-switch-type ${rule.type.toLowerCase()}">${getRuleTypeLabel(rule.type)}</span>
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
// TRADING SETTINGS
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

if (minBuyersToPassInput) {
    minBuyersToPassInput.addEventListener('change', function () {
        if (this.value >= 1) {
            socket.emit('updateTradingSetting', { key: 'minBuyersToPass', value: this.value });
        }
    });
}

if (showAllBuyersToggle) {
    showAllBuyersToggle.addEventListener('change', function () {
        socket.emit('updateTradingSetting', { key: 'showAllEarlyBuyers', value: this.checked });
    });
}

if (buySlippageInput) {
    buySlippageInput.addEventListener('change', function () {
        if (this.value >= 1) {
            socket.emit('updateTradingSetting', { key: 'buySlippage', value: this.value });
        }
    });
}

if (sellSlippageInput) {
    sellSlippageInput.addEventListener('change', function () {
        if (this.value >= 1) {
            socket.emit('updateTradingSetting', { key: 'sellSlippage', value: this.value });
        }
    });
}

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
