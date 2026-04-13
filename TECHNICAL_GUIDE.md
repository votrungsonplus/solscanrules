# 🛠️ TECHNICAL GUIDE - SOLANA SCAN BOT

Tài liệu này cung cấp cái nhìn chi tiết về kiến trúc, luồng xử lý dữ liệu và logic nghiệp vụ của Bot dành cho lập trình viên (Developers) hoặc người mới muốn tìm hiểu và mở rộng hệ thống.

---

## 1. Kiến trúc Hệ thống (Architecture Overview)

Dự án được xây dựng theo mô hình **Event-Driven (Hướng sự kiện)**, tập trung vào tốc độ xử lý song song để bắt kịp các cơ hội trên PumpFun.

### Các thành phần chính:
- **Core Orchestrator (`src/core/orchestrator.js`)**: "Bộ não" điều phối toàn bộ luồng công việc.
- **Detector (`src/core/pumpfun-detector.js`)**: Lắng nghe WebSocket từ PumpPortal để phát hiện token mới tạo.
- **Rule Engine (`src/engine/rule-engine.js`)**: Bộ lọc quy tắc linh hoạt để quyết định token nào đạt tiêu chuẩn.
- **Analyzers (`src/analyzers/`)**: Các module phân tích chuyên sâu (phân tích ví, chấm điểm rủi ro, phát hiện nhóm ví chung nguồn tiền).
- **Executors (`src/executor/`)**: Thực thi lệnh mua (Buy) và bán (Sell) tự động (có tích hợp Jito Bundle).
- **Tracker (`src/tracker/trade-tracker.js`)**: Quản lý Database SQLite để lưu vết và tính toán lãi lỗ (PnL).

---

## 2. Luồng Xử lý Dữ liệu (Data Workflow)

1.  **Detection**: `PumpPortal` gửi signal token mới vừa "launched" trên PumpFun qua WebSocket.
2.  **Initial Scan**: `Orchestrator` nhận token, gán vào một pipeline phân tích song song.
3.  **Deep Analysis**:
    -   Lấy thông tin Metadata và Bondings từ RPC.
    -   Lấy danh sách **5-10 ví mua sớm nhất**.
    -   `WalletAnalyzer` truy vết nguồn tiền của các ví này để tìm **shared funders (Cabal/Cluster)**.
    -   `TokenScorer` tính điểm rủi ro dựa trên lịch sử của ví Deployer.
4.  **Rule Filtering**: `RuleEngine` nhận toàn bộ dữ liệu phân tích và kiểm tra qua các quy tắc (MCap, Volume, Age, Cluster...).
5.  **Execution**: Nếu đạt chuẩn (`shouldBuy: true`), `BuyExecutor` sẽ gửi giao dịch ngay lập tức (ưu tiên Jito Bundle để chống MEV và tăng tốc).
6.  **Monitoring**: Token đã mua sẽ đưa vào `SellExecutor` để theo dõi giá qua WebSocket/Price API, chờ chạm mức **Take Profit (TP)** hoặc **Stop Loss (SL)**.

---

## 3. Hệ thống Quy tắc (Rule Engine Details)

Mỗi quy tắc (Rule) trong bot được gán một loại (`RuleType`) để xử lý phản hồi Telegram khác nhau:

- **REQUIRE**: Các quy tắc "cứng". Nếu không thỏa mãn, bot sẽ bỏ qua token hoàn toàn (VD: Market Cap > 78 SOL).
- **BLOCK**: Các quy tắc "ngăn chặn". Nếu vi phạm, bot sẽ báo cáo và dừng ngay lập tức (VD: Dev nắm giữ quá nhiều supply).
- **ALERT**: Cảnh báo rủi ro. Bot vẫn có thể duyệt qua nhưng sẽ gắn nhãn cảnh báo (VD: Ví mới toanh).
- **INFO**: Cung cấp thêm thông tin minh họa cho người dùng.

> [!TIP]
> **Cách thêm Rule mới**: 
> Bạn chỉ cần tạo một class kế thừa logic trong `src/engine/rule-engine.js`, thêm định nghĩa vào `this.rules` và logic kiểm tra trong hàm tương ứng.

---

## 4. Phân tích Nhóm Ví (Cluster Detection)

Đây là tính năng quan trọng nhất của bot để phát hiện "Cabal" (nhóm lái token):
- **Logic**: Bot tải lịch sử 20 giao dịch của từng ví mua sớm.
- **Truy vết**: Lần theo giao dịch `SOL Transfer` đầu tiên của ví đó để xem ai là người cấp phí (Funder).
- **Shared Funders**: Nếu ≥ 2 ví mua sớm được cấp tiền từ cùng một ví mẹ, bot sẽ gán nhãn **Cluster Detected** và tính toán độ rủi ro dựa trên số lượng ví con và uy tín của ví mẹ.

---

## 5. Giải thích Biến Môi trường (.env)

| Biến | Ý nghĩa | Lợi ích cho Dev |
| :--- | :--- | :--- |
| `SOLANA_RPC_URLS` | Danh sách RPC ưu tiên | Có thể dùng nhiều RPC để Load balancing bằng `solana-connection.js`. |
| `WALLET_PRIVATE_KEY` | Private Key của ví bot | Để trống = Chế độ Monitor (chỉ xem, không mua). |
| `AUTO_BUY_ENABLED` | Tự động mua | Có thể bật/tắt qua Dashboard mà không cần restart. |
| `JITO_ENABLED` | Sử dụng Jito Bundle | Giúp giao dịch không bị revert và tránh bị front-run. |
| `GLOBAL_FEE_THRESHOLD` | Ngưỡng phí ưu tiên | Lọc các token có "tiền lực" (Deployer trả nhiều phí để lên top). |

---

## 6. Cấu trúc Cơ sở Dữ liệu (SQLite)

Bot sử dụng `data/trades.db` để lưu trữ lâu dài:
- **`trades`**: Lưu mọi lệnh mua/bán thành công và PnL thực tế.
- **`token_scans`**: Lưu lịch sử mọi token đã từng quét, bao gồm cả lý do tại sao nó bị loại (giúp backtest và tinh chỉnh rule).
- **`daily_stats`**: Lưu tổng kết lãi lỗ theo ngày.
- **`bot_settings`**: Lưu các cài đặt thay đổi từ Dashboard (ghi đè file .env).

---

## 7. Hướng dẫn Mở rộng (Next Steps for Devs)

1.  **Thêm Analyzer mới**: Tạo file trong `src/analyzers/`, ví dụ `holder-concentration.js` để phân tích sâu hơn độ tập trung holder.
2.  **Tích hợp DEX khác**: Hiện bot tập trung vào PumpFun, bạn có thể mở rộng `src/services/price-service.js` để hỗ trợ Meteora hoặc Orca.
3.  **Thay đổi giao diện**: Chỉnh sửa tại `src/web/public/` (Bot sử dụng HTML/JS thuần để tối đa tốc độ tải).

---
> [!IMPORTANT]
> **Bảo mật**: Tuyệt đối không bao giờ chia sẻ file `.env` hoặc file `.db` thực tế khi commit lên GitHub. Luôn sử dụng `.env.example` làm mẫu.
