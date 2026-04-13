# TÀI LIỆU PHÂN TÍCH KỸ THUẬT QUY TẮC VẬN HÀNH (BANBAOCAO1)
**Dự án**: Solana Scan Bot
**Đối tượng**: Developer & AI Analysis (Claude)

Tài liệu này mô tả chi tiết từ điển dữ liệu, giải thuật của từng quy tắc (Rules) và cách thức hệ thống kiểm tra các biến số trước khi đưa ra quyết định giao dịch.

---

## I. TỪ ĐIỂN DỮ LIỆU (DATA CONTEXT)
Toàn bộ Rules được đánh giá dựa trên một đối tượng `ctx` (Context) chứa các thành phần sau:

### 1. ctx.tokenData (Thông tin Token)
| Biến số | Giải thích | Nguồn/Cách kiểm tra |
| :--- | :--- | :--- |
| `mint` | Địa chỉ hợp đồng của Token. | Lấy từ sự kiện NewToken của PumpFun. |
| `deployer` | Địa chỉ ví tạo ra token. | Trích xuất từ giao dịch khởi tạo. |
| `marketCapSol` | Vốn hóa thị trường tính bằng SOL. | Tính dựa trên hằng số Bonding Curve (vSol/vTokens). |
| `globalFee` | Tổng phí giao dịch tích lũy trên PF. | Thu thập từ luồng trade trực tiếp (1% mỗi lệnh). |
| `volume` | Khối lượng giao dịch 24h. | Thường lấy từ DexScreener hoặc quy đổi từ GlobalFee. |
| `timestamp` | Thời gian token được list. | Unix timestamp (mili giây). |

### 2. ctx.earlyBuyers (Dữ liệu Người mua sớm)
*Mảng chứa Analysis của 5-10 người mua đầu tiên.*
- `address`: Địa chỉ ví người mua.
- `isWhiteWallet`: Boolean. Xác định ví nếu: `txCount == 0` TRƯỚC khi mua token VÀ được nạp tiền sát giờ launch.
- `fundingWallets`: Danh sách ví đã chuyển SOL cho ví này. Trình thu thập dữ liệu sẽ quét ngược 1-2 tầng transfer.
- `walletAgeDays`: Tuổi thọ của ví tính từ giao dịch đầu tiên.
- `firstTxTimestamp`: Thời gian diễn ra giao dịch đầu tiên của ví.

### 3. ctx.holderStats (Thống kê nắm giữ)
- `top10Percent`: Tổng % supply nắm bởi Top 10 ví (đã trừ Pool).
- `devHoldPercent`: % supply nằm trong ví Deployer.
- `bundleHoldPercent`: % supply mua trong cùng block khởi tạo (Snipers).

---

## II. CẤU TRÚC VẬN HÀNH CHI TIẾT CỦA 15 RULES

### Rule 1: White Wallet From Deployer (ALERT)
- **Biến kiểm tra**: `tokenData.deployer` so với `earlyBuyer.fundingWallets`.
- **Cơ chế**: Vòng lặp duyệt qua 5 ví mua sớm. Nếu bất kỳ ví nào có địa chỉ ví mẹ trùng với `deployer` AND ví đó là ví mới (`isWhiteWallet`) → Trả về `passed: false`.
- **Mục đích**: Phát hiện ví insider của dev.

### Rule 2: White Wallet From CEX (INFO)
- **Biến kiểm tra**: `earlyBuyer.sourceOfFunds.hasCEXFunding`.
- **Cơ chế**: Kiểm tra tầng nạp tiền thứ 2. Nếu SOL đến từ ví nóng của sàn tập trung (Binance, OKX...) → Gán nhãn `PASS` để lưu thông tin.

### Rule 3: Same Buy Amount Detection (ALERT)
- **Biến kiểm tra**: `earlyBuyerTrades.solAmount`.
- **Giải thuật**: 
  1. Lấy mảng lượng SOL của 10-20 trade đầu tiên.
  2. Tạo các nhóm (groups) dựa trên `tolerancePercent` (Mặc định 10%). 
  3. Nếu một nhóm có ≥ 3 ví mua lượng tiền tương đương nhau → Kết luận có Cabal.
- **Ví dụ**: 0.05 SOL, 0.051 SOL, 0.049 SOL sẽ bị gom vào một nhóm.

### Rule 4: Global Fee Threshold (REQUIRE)
- **Biến kiểm tra**: `tokenData.globalFee` hoặc `tokenData.volume / 100`.
- **Cơ chế**: So sánh hằng số `settings.rules.minGlobalFee` (Mặc định 0.3 SOL). 
- **Điều kiện**: `Fee >= Threshold`.

### Rule 5: Cluster Detection (REQUIRE)
- **Biến kiểm tra**: `clusterAnalysis.sharedFunders.length`.
- **Cơ chế**: Quét đồ thị giao dịch. Nếu ≥ 3 ví mua sớm được nạp tiền từ cùng một nhóm ví mẹ (Shared Funders) → Xác nhận tín hiệu Cabal mạnh.
- **Tại sao quan trọng**: Phải có "đội" (cluster) thì giá mới có khả năng x5 x10 bền vững.

### Rule 6: Dev Risk Check (ALERT)
- **Biến kiểm tra**: `devAnalysis.riskScore`.
- **Cơ chế**: API phân tích lịch sử dev. So sánh với `settings.rules.maxRiskScore` (Mặc định 60).
- **Phân loại**: 0-20 (Low), 21-40 (Medium), 41-60 (High), >60 (Critical).

### Rule 9, 10, 11: Holders Limits (REQUIRE)
- **Biến kiểm tra**: `holderStats.top10Percent`, `holderStats.devHoldPercent`, `holderStats.bundleHoldPercent`.
- **Cơ chế**: So sánh trực tiếp với các ngưỡng `maxPercentTop10` (30%), `maxPercentDev` (20%), `maxPercentBundle` (20%).
- **Lưu ý**: Nếu `dataInvalid: true` (lỗi API/Node) → Tự động `FAIL` để đảm bảo an toàn.

### Rule 14: Market Cap Check (REQUIRE - RETRYABLE)
- **Biến kiểm tra**: `tokenData.marketCapSol`.
- **Giải thuật**: 
  - Nếu `MCap < minMarketCapSol`: Trả về `passed: false` VÀ `retryable: true`.
  - Hệ thống sẽ không dừng lại mà đưa vào hàng đợi re-scan sau mỗi 10 giây.
  - Quá trình re-scan dừng lại khi đạt MCap hoặc Token vượt quá age limit (Rule 13).

### Rule 15: Fresh Wallet Detection (ALERT)
- **Biến kiểm tra**: `earlyBuyer.walletAgeDays` & `earlyBuyer.firstTxTimestamp`.
- **Giải thuật**: 
  1. Xác định ví "Mới toanh": Tuổi < 1 ngày VÀ Giao dịch đầu tiên diễn ra trong vòng 2 giờ trước khi mua token.
  2. Nếu số lượng ví này > `maxFreshCount` (4 ví) → Cảnh báo Rug Pull tiềm ẩn (Dev nạp tiền hàng loạt ví mới để tạo FOMO).

---

## III. QUY TRÌNH RA QUYẾT ĐỊNH (DECISION FLOW)

1. **Tổng hợp**: Chạy vòng lặp qua 15 Rules.
2. **Loại bỏ**: Nếu có bất kỳ Rule loại `REQUIRE` hoặc `BLOCK` nào bị `FAIL` → `shouldBuy: false`.
3. **Cảnh báo**: Các Rule loại `ALERT` bị `FAIL` sẽ được ghi vào danh sách `alertReasons` để hiển thị màu đỏ trên Dashboard nhưng không ngăn cản lệnh mua.
4. **Hành động**:
   - `shouldBuy == true`: Gửi Tx tới Jito.
   - `onlyRetryableFailed == true`: Gửi lại hàng đợi phân tích (Re-scan).
   - Còn lại: Bỏ qua (Ignore).

---
**Tài liệu này phản ánh chính xác Logic Core phiên bản hiện tại.**
