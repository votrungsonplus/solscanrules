# BÁO CÁO PHÂN TÍCH TOÀN DIỆN — ĐIỀU KIỆN PASS TOKEN

> Ngày: 2026-04-15
> Phiên bản: v2.0 — Sau khi thống nhất định nghĩa và thêm rule mới

---

## 1. TỔNG QUAN HỆ THỐNG RULES

Hệ thống có **19 rules** (18 cũ + 1 mới), chia thành 4 loại:

| Loại | Ý nghĩa | Số lượng |
|------|---------|----------|
| **REQUIRE** | Bắt buộc phải pass, nếu fail → CHẶN | 7 |
| **BLOCK** | Chặn cứng, fail = không mua | 4 |
| **ALERT** | Cảnh báo, fail vẫn có thể mua | 3 |
| **INFO** | Thông tin, không ảnh hưởng quyết định | 2 |

### Thứ tự thực thi (19 rules):

| # | Rule ID | Loại | Trạng thái |
|---|---------|------|-----------|
| 1 | `white_wallet_from_deployer` | ALERT | Bật |
| 2 | `white_wallet_from_cex` | INFO | Bật |
| 3 | `same_buy_amount` | ALERT | Bật |
| 4 | `global_fee_threshold` | REQUIRE | Bật |
| 5 | `cluster_detection` | REQUIRE | Bật |
| 6 | `sybil_protection` | BLOCK | Bật |
| 7 | `top10_holder_limit` | REQUIRE | Bật |
| 8 | `dev_hold_limit` | REQUIRE | Bật |
| 9 | `bundle_limit` | REQUIRE | Bật |
| 10 | `volume_threshold` | REQUIRE | Bật |
| 11 | `listing_age_limit` | REQUIRE | Bật |
| 12 | `market_cap_check` | REQUIRE (retry) | Bật |
| 13 | `dev_risk_check` | ALERT | Bật |
| 14 | `token_score_check` | REQUIRE | Tắt |
| 15 | `bonding_curve_progress` | INFO | Tắt |
| 16 | `fresh_wallet_check` | ALERT | **Tắt (Legacy)** |
| 17 | `new_wallet_accumulation` | BLOCK | **Bật (MỚI)** |
| 18 | `first_7_buyers_hold_limit` | BLOCK | Bật |
| 19 | `early_buyer_count_check` | BLOCK | Bật |

---

## 2. VẤN ĐỀ PHÂN MẢNH ĐỊNH NGHĨA "VÍ MỚI" (ĐÃ SỬA)

### Trước khi sửa — 3 định nghĩa khác nhau:

| Nơi | Điều kiện | Vấn đề |
|-----|-----------|--------|
| `wallet-analyzer.js` → `isNewWallet` | txCount < 20 HOẶC age < 7 ngày | Quá lỏng, hầu hết ví đều match |
| `wallet-analyzer.js` → `isWhiteWallet` | txCount <= 5 VÀ age < 7 ngày VÀ 1 funding source | Dùng cho mục đích khác (cluster) |
| `fresh-wallet-check.rule.js` | walletAgeDays < 1 VÀ firstTx trong 2h | Không check số tx |

### Sau khi sửa — Định nghĩa thống nhất:

```
isFreshNewWallet = (tuổi ví < 10 tiếng) VÀ (số giao dịch < 5)
```

- **File**: `wallet-analyzer.js` dòng 65-68
- **Dùng ở**: `new-wallet-accumulation.rule.js`, `fresh-wallet-check.rule.js` (legacy)
- **isNewWallet** vẫn giữ lại (txCount < 20 || age < 7 ngày) để quyết định có fetch funding data hay không (tối ưu RPC)
- **isWhiteWallet** không thay đổi — phục vụ cluster detection, không liên quan

---

## 3. RULE MỚI: `new_wallet_accumulation`

### Điều kiện pass:

```
CHẶN nếu:
  1. Trong X ví mua đầu tiên, TẤT CẢ đều là "ví mới" (isFreshNewWallet)
  2. VÀ tổng token các ví đó nắm giữ >= Y% tổng cung
```

### Tham số tuỳ chỉnh:

| Tham số | Biến ENV | Mặc định | Mô tả |
|---------|----------|----------|-------|
| X | `RULE_ACCUMULATION_CHECK_X` | 5 | Số ví mua đầu tiên cần kiểm tra |
| Y | `RULE_ACCUMULATION_MAX_PCT` | 15% | Ngưỡng % tổng cung tối đa |
| includeBundleAsNew | (dashboard toggle) | true | Có tính ví bundle vào ví mới không |

### Giá trị trong từng profile:

| Profile | X | Y | includeBundleAsNew |
|---------|---|---|-------------------|
| strict_current | 5 | 10% | Có |
| balanced_backup3 | 5 | 15% | Có |
| loose_backup2 | 5 | 20% | Có |

---

## 4. CÁC RULE BỊ TÁC ĐỘNG

### 4.1. `fresh_wallet_check` → DISABLED

- **Lý do**: Logic đã được gộp hoàn toàn vào `new_wallet_accumulation`
- **Rule mới tốt hơn vì**: Kết hợp cả phát hiện ví mới + kiểm tra % supply (rule cũ chỉ đếm số lượng)
- **Tương thích ngược**: Rule vẫn tồn tại, có thể bật lại nếu cần, đã cập nhật sang định nghĩa thống nhất

### 4.2. `first_7_buyers_hold_limit` → GIỮ NGUYÊN

- **Lý do giữ**: Rule này kiểm tra 7 lệnh đầu BẤT KỂ ví mới hay cũ, vẫn có giá trị riêng
- **Phân biệt**: `new_wallet_accumulation` chỉ chặn khi TẤT CẢ X ví đầu đều là ví mới, còn `first_7_buyers_hold_limit` chặn bất kỳ ai gom quá nhiều

### 4.3. `bundle_limit` → GIỮ NGUYÊN, BỔ SUNG LIÊN KẾT

- **Thay đổi**: `bundleWallets` giờ được truyền vào context rule engine (trước đó không có)
- **Tác dụng**: `new_wallet_accumulation` có thể nhận diện ví bundle và coi chúng là ví mới

---

## 5. LỖ HỔNG: BOT DÙNG VÍ CŨ ĐỂ QUA MẶT

### Kịch bản tấn công:

1. Bot tạo ví trước 1-2 tuần
2. Nạp SOL, thực hiện 5-10 giao dịch giả (swap qua lại)
3. Khi token mới ra → dùng các ví "cũ" này mua đầu tiên
4. Hệ thống phân loại là "Ví cũ" → bypass hoàn toàn `new_wallet_accumulation`

### Các rule khác có thể bắt:

| Rule | Khả năng bắt | Giải thích |
|------|--------------|------------|
| `cluster_detection` | **CÓ THỂ** | Nếu các ví cũ cùng được fund từ 1 nguồn |
| `same_buy_amount` | **CÓ THỂ** | Nếu bot dùng cùng số SOL để mua |
| `sybil_protection` | **KHÔNG** | Chỉ check top10 holder %, không detect ví cũ giả |
| `bundle_limit` | **CÓ THỂ** | Nếu bot mua cùng slot (bundle) |

### Khuyến nghị tương lai:

- Thêm kiểm tra "funding source overlap" cho early buyers (dù ví cũ hay mới)
- Phát hiện pattern: nhiều ví cũ cùng mua trong 30 giây đầu
- Cross-check lịch sử trading: ví "cũ" nhưng chỉ trade PumpFun token mới

---

## 6. CẤU TRÚC FILE ĐÃ THAY ĐỔI

```
src/
├── analyzers/
│   └── wallet-analyzer.js          ← Thêm isFreshNewWallet
├── config/
│   └── settings.js                 ← Thêm accumulationCheckFirstX, accumulationMaxPercent
├── core/
│   └── orchestrator.js             ← Truyền bundleWallets vào rule engine context
├── engine/
│   ├── rule-engine.js              ← Không thay đổi
│   ├── rule-profiles/
│   │   └── index.js                ← Thêm new_wallet_accumulation, disable fresh_wallet_check
│   └── rules/
│       ├── index.js                ← Import + đăng ký new_wallet_accumulation
│       └── buyers/
│           ├── new-wallet-accumulation.rule.js  ← MỚI
│           ├── fresh-wallet-check.rule.js       ← Cập nhật (legacy, disabled)
│           ├── first-7-buyers-hold-limit.rule.js ← Không đổi
│           ├── same-buy-amount.rule.js           ← Không đổi
│           └── early-buyer-count-check.rule.js   ← Không đổi
```

---

## 7. HƯỚNG DẪN SỬ DỤNG

### Qua biến môi trường (.env):

```bash
# Số ví mua đầu tiên cần kiểm tra
RULE_ACCUMULATION_CHECK_X=5

# Ngưỡng % tổng cung tối đa
RULE_ACCUMULATION_MAX_PCT=15
```

### Qua Dashboard (runtime):

```javascript
ruleEngine.updateRule('new_wallet_accumulation', {
  checkFirstXBuyers: 7,           // Kiểm tra 7 ví đầu
  maxAccumulationPercent: 10,     // Chặn nếu > 10% supply
  includeBundleAsNew: false,      // Không tính ví bundle
});
```
