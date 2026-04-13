# 📖 MASTER TECHNICAL DOCUMENTATION - SOLANA SCAN BOT (PUMPFUN SNIPER)

Chào mừng bạn đến với bộ tài liệu kỹ thuật đầy đủ nhất của bót Solana Scan. Tài liệu này được thiết kế để cung cấp cái nhìn chi tiết tuyệt đối về mọi khía cạnh của hệ thống, từ kiến trúc tổng quát đến từng dòng code logic, dành cho cả người mới (Newbies) và Lập trình viên (Developers).

---

## 🏗️ PHẦN 1: TỔNG QUAN KIẾN TRÚC & CÁC MODULE CHÍNH

Hệ thống được xây dựng theo kiến trúc **Hướng sự kiện (Event-Driven)** và **Bất đồng bộ (Asynchronous)** để tối ưu hóa tốc độ xử lý trong môi trường thị trường biến động mili giây.

### 1.1. Các Module cốt lõi
1.  **Core Orchestrator (`src/core/orchestrator.js`)**:
    - Là trung tâm điều phối. Nó kết nối tất cả các module khác lại với nhau.
    - Chịu trách nhiệm quản lý vòng đời của token: từ lúc phát hiện, phân tích đến khi quyết định mua/bán.
2.  **PumpFun Detector (`src/core/pumpfun-detector.js`)**:
    - Kết nối trực tiếp với WebSocket của `PumpPortal` (hoặc `PumpFun` gốc).
    - Lắng nghe hai tín hiệu chính: `newToken` (Token mới tạo) và `trade` (Lệnh mua/bán trên bonding curve).
3.  **Rule Engine (`src/engine/rule-engine.js`)**:
    - Chứa bộ lọc logic. Nó nhận toàn bộ dữ liệu phân tích và so sánh với các điều kiện người dùng đặt ra để trả về kết quả `shouldBuy` (nên mua hay không).
4.  **Analyzers (`src/analyzers/`)**:
    - **`wallet-analyzer.js`**: Truy vết lịch sử ví mua sớm để phát hiện Nhóm ví (Cluster) và Ví trắng (White wallet).
    - **`dev-analyzer.js`**: Kiểm tra rủi ro từ ví Deployer (kẻ tạo token).
    - **`token-scorer.js`**: Chấm điểm Metadata (Tên, Ảnh, Social link) của token.
5.  **Executors (`src/executor/`)**:
    - **`buy-executor.js`**: Chịu trách nhiệm mua token nhanh nhất có thể (hỗ trợ Jito Bundle).
    - **`sell-executor.js`**: Theo dõi giá và thực hiện chốt lời (TP), cắt lỗ (SL).
6.  **Trade Tracker (`src/tracker/trade-tracker.js`)**:
    - Quản lý Cơ sở dữ liệu SQLite (`trades.db`). Lưu lịch sử giao dịch, thống kê PnL và cấu hình bót.

---

## 🌊 PHẦN 2: LUỒNG CÔNG VIỆC CHI TIẾT (TOKEN LIFECYCLE)

Quy trình xử lý một token diễn ra theo các bước sau đây mà không có ngoại lệ:

### Bước 1: Phát hiện (Detection)
- Khi một token được tạo trên PumpFun, `pumpfun-detector` nhận tín hiệu `newToken` và gửi về `Orchestrator`.
- Bot bắt đầu theo dõi 10 ví mua sớm đầu tiên (`early buyers`) của token đó qua luồng sự kiện `trade`.

### Bước 2: Theo dõi & Tích lũy (Monitoring)
- Bot chờ đợi cho đến khi tích lũy đủ số lượng ví mua sớm tối thiểu (thường là 5 ví - tùy cấu hình `MIN_BUYERS_TO_PASS`).
- Nếu trong 5 phút đầu không đủ 5 ví mua, bot sẽ tự động đánh dấu "Timeout" và bỏ qua token này để tiết kiệm tài nguyên.

### Bước 3: Phân tích Song song (Parallel Analysis)
Ngay khi có người mua đầu tiên, bot bắt đầu chạy phân tích ngay lập tức và chạy **song song** để tiết kiệm thời gian:
- **Luồng A**: Lấy Holder Stats (danh sách người nắm giữ) từ RPC.
- **Luồng B**: Chạy `WalletAnalyzer` để quét lịch sử giao dịch của các ví mua sớm nhằm tìm ra nguồn tiền (Cabal Detection).
- **Luồng C**: Chạy `DevAnalyzer` kiểm tra ví người tạo.

### Bước 4: Đánh giá Quy tắc (Rule Evaluation)
- Toàn bộ dữ liệu từ Bước 3 được nạp vào `Rule Engine`.
- Nếu có bất kỳ điều kiện `REQUIRE` hoặc `BLOCK` nào vi phạm, bót sẽ dừng lại ngay và báo cáo lý do lên Dashboard.
- Nếu token chỉ thiếu Vốn hóa (Market Cap), bót sẽ đưa vào hàng chờ **Re-scan** sau mỗi 5-8 giây cho đến khi đạt yêu cầu hoặc hết thời gian (5 phút).

### Bước 5: Thực thi & Cảnh báo (Execution & Alerts)
- **Nếu đạt chuẩn (Pass)**:
    1. Lập tức đánh tín hiệu Mua qua `BuyExecutor` (nếu bật Auto-buy).
    2. Gửi thông báo chi tiết (Alert) qua Telegram kèm theo các thông tin phân tích.
- **Sau khi mua**: Token được bàn giao cho `SellExecutor` để theo dõi giá thời gian thực.


---

## 🔬 PHẦN 3: PHÂN TÍCH QUY TẮC (RULE ENGINE) & LOGIC XỬ LÝ SÂU

Bộ não của bót nằm ở `Rule Engine`. Mỗi quy tắc được phân loại để bót biết cách phản ứng:

### 3.1. Phân loại Quy tắc (Rule Types)
1.  **REQUIRE (Bắt buộc)**: Điều kiện "cứng". Nếu không đạt, bót sẽ không bao giờ mua. (VD: Market Cap phải đạt tối thiểu).
2.  **BLOCK (Chặn ngay)**: Nếu phát hiện dấu hiệu này, bót sẽ dừng phân tích ngay lập tức (VD: Dev nắm giữ > 20% tổng cung).
3.  **ALERT (Cảnh báo)**: Không chặn mua nhưng sẽ hiển thị cảnh báo để người dùng lưu ý (VD: Ví mua sớm là ví mới tạo).
4.  **INFO (Thông tin)**: Chỉ hiển thị thêm thông tin để người dùng tham khảo.

### 3.2. Chi tiết các Rules quan trọng nhất
- **Cluster Detection (Nhóm ví)**:
    - Bót truy vết giao dịch đầu tiên của 10 ví mua sớm. Nếu có 2 ví trở lên nhận tiền từ cùng một "Ví mẹ" (`shared funder`), bót sẽ đánh dấu là có Nhóm ví (Insider Signal).
    - Đây là tín hiệu quan trọng nhất của các dự án "Cabal" có khả năng tăng trưởng mạnh.
- **Market Cap Check**:
    - Bót kiểm tra vốn hóa tính bằng SOL. Nếu chưa đạt ngưỡng (VD: 78 SOL), bót sẽ đưa vào hàng chờ **Re-scan**. Token sẽ được quét lại liên tục khi có người mua mới đến khi đạt MC hoặc vượt quá 5 phút tuổi.
- **Holder Concentration**:
    - Bót tự động loại trừ các ví hệ thống của PumpFun (Bonding curve, Fee account) để tính toán tỷ lệ nắm giữ của Top 10 holder thực tế.

---

## ⚙️ PHẦN 4: GIẢI THÍCH TOÀN BỘ BIẾN SỐ & CẤU HÌNH

Hệ thống sử dụng file `.env` và `settings.js` để điều khiển hành vi. Dưới đây là các biến quan trọng:

### 4.1. Cấu hình RPC & Node
- `SOLANA_RPC_URLS`: Danh sách các RPC. Bót có chế độ **Failover** tự động chuyển sang RPC tiếp theo nếu một cái bị chậm.
- `SOLANA_WS_URL`: WebSocket để nhận dữ liệu thời gian thực.
- `HELIUS_EXECUTION_RPC_URL`: RPC chuyên dụng để gửi giao dịch (nếu có).

### 4.2. Cấu hình Trading (Giao dịch)
- `BUY_AMOUNT_SOL`: Số lượng SOL bót bỏ ra cho mỗi lệnh mua tự động.
- `AUTO_BUY_ENABLED`: `true` là bót tự mua, `false` là bót chỉ gửi cảnh báo.
- `MAX_CONCURRENT_POSITIONS`: Số lượng token tối đa bót được phép giữ cùng một lúc (VD: 5 token).
- `DAILY_LOSS_LIMIT_SOL`: Giới hạn lỗ tối đa trong ngày. Nếu vượt qua, bót sẽ dừng mua.

### 4.3. Cấu hình Theo dõi (Monitoring)
- `EARLY_BUYERS_TO_MONITOR`: Số lượng ví mua sớm sẽ được bot truy vết (Mặc định: 10 ví).
- `MIN_BUYERS_TO_PASS`: Số ví mua sớm tối thiểu cần có trước khi bot đưa ra quyết định mua.

---

## 💸 PHẦN 5: CƠ CHẾ GIAO DỊCH (JITO, GAS, SLIPPAGE)

Tốc độ là yếu tố sống còn. Bót sử dụng các công nghệ sau:

### 5.1. Jito Bundle Support
- Khi bật `JITO_ENABLED=true`, bót không gửi lệnh đơn lẻ mà gửi một "Bundle" kèm theo tiền TIP cho miner.
- **Lợi ích**: Chống bị Front-run (MEV) và đảm bảo lệnh mua chắc chắn thành công trên chuỗi.

### 5.2. Phí ưu tiên (Priority Fees)
- Bót tự động tính toán phí ưu tiên linh hoạt theo mức độ nghẽn của mạng lưới (thông qua `PRIORITY_FEE_MULTIPLIER`).

### 5.3. Take Profit & Stop Loss
- **TP (Chốt lời)**: Bót theo dõi giá thời gian thực. Khi đạt %, bót sẽ tự động xả 100% vị thế.
- **SL (Cắt lỗ)**: Nếu giá giảm xuống ngưỡng cài đặt, bót sẽ thoát hàng ngay lập tức để bảo toàn vốn.

---

## 💾 PHẦN 6: CƠ SỞ DỮ LIỆU & THỐNG KÊ PNL

Toàn bộ dữ liệu nằm ở `data/trades.db` (SQLite):

- **Bảng `trades`**: Lưu lịch sử mua/bán, chữ ký giao dịch (Signature) và lợi nhuận thực tế.
- **Bảng `token_scans`**: Lưu lại mọi lý do tại sao một token bị bót từ chối (giúp bạn điều chỉnh Rule sau này).
- **Phần mềm quản lý**: Bạn có thể dùng `DB Browser for SQLite` để mở file này và xem dữ liệu thủ công.

---

## 🛠️ PHẦN 7: DÀNH CHO DEVELOPER & QUY TRÌNH SAO LƯU

### 7.1. Cách thêm một Rule mới
1. Mở file `src/engine/rule-engine.js`.
2. Dùng hàm `this.addRule('tên_rule', { ... })` để định nghĩa logic kiểm tra.
3. Đăng ký thông báo vào Telegram ở `src/telegram/telegram-bot.js`.

### 7.2. Quy trình Sao lưu & Phục hồi (Backup)
- **Sao lưu**: Bạn chỉ cần copy 2 file quan trọng nhất là:
    1. File `.env` (Chứa chìa khóa ví và cấu hình).
    2. File `data/trades.db` (Chứa toàn bộ lịch sử giao dịch và lãi lỗ).
- **Phục hồi**: Cài đặt lại bót trên máy mới, dán 2 file này vào đúng vị trí cũ, bót sẽ tiếp tục chạy mà không bị mất dữ liệu.

---
> [!IMPORTANT]
> **BẢO MẬT**: Không bao giờ chia sẻ file `.env` cho bất kỳ ai, vì nó chứa Private Key có quyền rút toàn bộ tiền trong ví của bạn.

*Tài liệu này được biên soạn bởi Antigravity dành riêng cho dự án Solana Scan Bot.*
