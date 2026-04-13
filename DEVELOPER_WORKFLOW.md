# TÀI LIỆU LUỒNG CÔNG VIỆC CHUẨN CHO DEVELOPER (SCAN SOL BOT)

Tài liệu này mô tả chi tiết kiến trúc kỹ thuật nội bộ, luồng xử lý dữ liệu và vòng đời của một token trong hệ thống **SCAN SOL BOT**, giúp Developer mới nắm bắt nhanh cách hệ thống vận hành và cách mở rộng tính năng.

---

## 1. Cấu trúc hệ thống & Component chính

Hệ thống được thiết kế theo dạng module rời rạc, điều phối tập trung bởi `orchestrator.js`.

- **`core/`**: Chứa các service cốt lõi.
  - `orchestrator.js`: "Bộ não" trung tâm, load cài đặt, nhận sự kiện từ các detector, gọi các analyzer và ra quyết định thông qua rule engine.
  - `pumpfun-detector.js`: Khởi tạo WebSocket kết nối với PumpPortal để nhận tín hiệu raw sub-second (token mới, trade mới).
  - `solana-connection.js`: Quản lý kết nối rpc, auto-failover khi node bị rate-limit.
- **`analyzers/`**: Các module đảm nhiệm chức năng phân tích chuyên sâu (async).
  - `wallet-analyzer.js`: Phân tích ví early buyer, tìm source funds, phát hiện white wallet, cabal/cluster.
  - `dev-analyzer.js`: Kiểm tra lịch sử deployer, risk scoring.
  - `token-scorer.js`: Đánh giá metadata token.
- **`engine/`**: 
  - `rule-engine.js`: Hệ thống tính điểm và check các hard-requirements. Các rule có thể bật/tắt động.
- **`executor/`**: Xử lý giao dịch on-chain thực tế.
  - `buy-executor.js` & `sell-executor.js`: Build transaction, tính toán slippage, bắn qua PumpPortal hoặc Jito Bundle.
  - `paper-trade-executor.js`: Hệ thống giả lập giao dịch (Simulator) để backtest realtime.
- **`tracker/`**: 
  - `trade-tracker.js`: Tương tác với SQLite để lưu trạng thái token, pnl, lịch sử trade, settings, ...
- **`web/` & `telegram/`**: Giao diện báo cáo và tương tác với người dùng.

---

## 2. Các nguồn dữ liệu & Phân vai chính xác

Developer cần phân biệt rõ nguồn cấp dữ liệu để dùng đúng tool cho đúng việc:

1. **PumpPortal / PumpFun WebSocket**:
   - **Mục đích**: Nguồn phát hiện token MỚI NHẤT và NHANH NHẤT. Bắn sự kiện realtime cho token creation và trade events.
   - **Lưu ý**: Không dùng nguồn này để query historical data.

2. **Solana RPC**:
   - **Mục đích**: Query on-chain data (Holders, Token Supply, Account Balance, Transaction Signatures) & Confirm Tx.
   - **Lưu ý**: Rất dễ dính Rate Limit (429), nên dùng batch (getMultipleAccountsInfo) và cache. Không dùng RPC để "quét liên tục tìm token mới".

3. **DexScreener API**:
   - **Mục đích**: Lấy dữ liệu Secondary Market, Token đã migrate khỏi PumpFun, giá FDV/MCap tổng hợp.
   - **Lưu ý**: Data bị trễ nhẹ, dùng cho tính năng "/refresh" hoặc update PnL ở Dashboard.

---

## 3. Vòng đời chi tiết của 1 Token (Token Life Cycle)

Đây là quy trình chính xác từ lúc Token lên PumpFun cho tới lúc Bot báo tín hiệu:

### Bước 1: Phát hiện (Detection)
- `pumpfun-detector.js` nhận tín hiệu `newToken` từ WebSocket.
- Emit event sang `orchestrator.js`.
- Bắt đầu theo dõi các trades (`_onTrade`) của token này qua WebSocket.
- Ghi log ra database (SQLite) và đẩy lên Web Dashboard (Real-time).

### Bước 2: Theo dõi & Ghi nhận Early Buyers
- Khi có event `trade` dạng mua (Buy) diễn ra.
- Lọc ra 5-10 người mua đầu tiên. (Skip nếu đó là duplicate).
- **Triggers**: Ngay khi đủ điều kiện chặn ban đầu (ví dụ: người mua đầu tiên xuất hiện), token được chuyển vào **Analysis Queue**.

### Bước 3: Phân tích song song (Parallel Analysis)
Bot gắp token từ Queue và chạy `_runFullAnalysis(mint)`. Các luồng chạy song song:
1. **Holder Analysis** (`_fetchTokenHolders`):
   - Loại trừ PumpFun System wallets, Bonding curve PDA, Fee accounts.
   - Cập nhật số liệu Concentation (Top 10 holders %).
2. **Wallet Analysis** (`walletAnalyzer`):
   - Quét lịch sử ví của early buyers. Đánh dấu *White Wallet* (insider) hoặc *Organic*.
   - Tìm kiếm liên kết (Cluster/Cabal).
3. **Dev Analysis** (`devAnalyzer`):
   - Lọc metadata token, lịch sử ví deployer.

### Bước 4: Đánh giá bằng Rule Engine
- Nạp toàn bộ dữ liệu vừa thu thập vào `ruleEngine.evaluate(tokenData)`.
- Duyệt qua danh sách rules (bật/tắt trong settings).
- **REQUIRE**: Các rule bắt buộc (phải PASS, ví dụ: bắt buộc phải có cabal/cluster).
- **ALERT**: Tăng risk warning.
- Điểm tổng cuối cùng định đoạt token có được cho phép giao dịch hay không.

### Bước 5: Thực thi & Cảnh báo (Execution & Alerts)
- **Nếu FAIL**: Loại bỏ, dừng theo dõi token đó để giảm tải.
- **Nếu PASS**: 
  - Gửi Telegram Alert.
  - Phát tín hiệu xanh lên Web Dashboard.
  - Nếu `Auto-buy` là ON: Đẩy sang `buy-executor.js`.
  - Nếu `Paper Trading` là ON: Đẩy sang `paperTradeExecutor.js`.

### Bước 6: Theo dõi diễn biến (Position Monitoring)
- Xử lý Take-profit (TP), Stop-loss (SL) qua `sell-executor.js` mỗi khi có biến động giá.
- Cập nhật "Highest MCap" liên tục phục vụ thống kê PnL Max.

---

## 4. Hướng dẫn mở rộng (Dành cho Dev)

### 4.1. Thêm Rule mới vào Bot
1. Định nghĩa Rule Object bao gồm: `id`, `type` ("REQUIRE", "ALERT", "INFO"), và callback `evaluate(data, context)` trong thư mục engine.
2. Đăng ký Rule vào `ruleEngine`.
3. Mở `trade-tracker.js` để thêm logic lưu trữ (bật/tắt) cho rule mới vào settings DB.

### 4.2. Tối ưu hoá Rate Limit cho RPC
- Khi verify nhiều ví, **bắt buộc** dùng `getMultipleAccountsInfo` thay vì vòng lặp `getParsedAccountInfo`.
- Nếu cần cache dữ liệu, sử dụng Memory Cache cục bộ (như `holderStatsCache`) với cơ chế TTL để tránh request lại quá nhiều trong 1 khoảng thời gian ngắn.

### 4.3. Xử lý UI/UX cho Dashboard
- Web backend nằm tại `src/web/server.js`, frontend nằm tại `src/web/public/`.
- Sử dụng `Socket.io` trong `server.js` để đẩy data theo thời gian thực.
