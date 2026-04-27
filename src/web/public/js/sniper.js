/* ═══════════════════════════════════════════════════════════
   SCAN SOL BOT — sniper.js
   Manual buy/sell panel — input validation + status log.
   Backend handlers (manualBuy/manualSell) chưa có trên server,
   nên panel hiện chỉ kiểm tra & hiển thị payload sẽ gửi.
   ═══════════════════════════════════════════════════════════ */

(() => {
    const mintInput = document.getElementById('sniperMintInput');
    const amountInput = document.getElementById('sniperAmountInput');
    const buyBtn = document.getElementById('btnSniperBuy');
    const sellBtn = document.getElementById('btnSniperSell');
    const log = document.getElementById('sniperStatusLog');

    if (!mintInput || !amountInput || !buyBtn || !sellBtn || !log) return;

    const setLog = (kind, text) => {
        log.className = 'sniper-log' + (kind ? ' ' + kind : '');
        log.textContent = text;
    };

    const validate = (mode) => {
        const mint = mintInput.value.trim();
        const amount = parseFloat(amountInput.value);

        if (!mint || !MINT_REGEX.test(mint)) {
            setLog('error', '✗ Địa chỉ Mint không hợp lệ — phải là chuỗi base58 dài 32–44 ký tự.');
            return null;
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            setLog('error', '✗ Số lượng phải là số dương.');
            return null;
        }
        if (mode === 'sell' && amount > 100) {
            setLog('error', '✗ Khi bán, số lượng là phần trăm — tối đa 100%.');
            return null;
        }
        return { mint, amount };
    };

    const execute = (mode) => {
        const data = validate(mode);
        if (!data) return;

        const action = mode === 'buy' ? 'MUA' : 'BÁN';
        const unit = mode === 'buy' ? 'SOL' : '%';

        setLog('loading', `⏳ Đang gửi lệnh ${action} ${data.amount} ${unit} cho ${data.mint.slice(0, 8)}…${data.mint.slice(-6)}…`);

        // Emit để server có thể xử lý nếu có handler tương ứng
        const eventName = mode === 'buy' ? 'manualSnipeBuy' : 'manualSnipeSell';
        socket.emit(eventName, { mint: data.mint, amount: data.amount });

        // Backend chưa có handler — báo trạng thái rõ ràng sau timeout ngắn
        const timeoutId = setTimeout(() => {
            setLog('error',
                `⚠ Server không phản hồi cho lệnh ${action.toLowerCase()} thủ công. ` +
                `Tính năng sniper bằng giao diện cần được kích hoạt phía server (chưa có handler '${eventName}').`
            );
        }, 4000);

        // Nếu server có handler, listener bên dưới sẽ huỷ timeout
        const onResult = (res) => {
            clearTimeout(timeoutId);
            socket.off('snipeResult', onResult);
            if (res?.success) {
                setLog('success',
                    `✓ ${action} thành công: ${res.signature || ''}\n` +
                    `Token: ${res.symbol || data.mint.slice(0, 8) + '…'}\n` +
                    `Khối lượng: ${res.amount || data.amount} ${unit}`
                );
            } else {
                setLog('error', `✗ Thất bại: ${res?.message || 'không rõ lỗi'}`);
            }
        };
        socket.on('snipeResult', onResult);
    };

    buyBtn.addEventListener('click', () => execute('buy'));
    sellBtn.addEventListener('click', () => execute('sell'));

    // Auto-clear log khi user gõ lại mint
    mintInput.addEventListener('input', () => {
        if (log.textContent && !log.classList.contains('loading')) {
            log.className = 'sniper-log';
            log.textContent = '';
        }
    });
})();
