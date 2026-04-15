# BÁO CÁO AUDIT — BIẾN PHÂN MẢNH & CHỨC NĂNG CHỒNG CHÉO

> Ngày: 2026-04-15
> Trạng thái: ĐÃ SỬA XONG

---

## TỔNG KẾT

| Mức độ | Số lỗi | Đã sửa |
|--------|--------|--------|
| HIGH | 1 | 1 |
| MEDIUM | 6 | 6 |
| TOTAL | 7 | 7 |

---

## LỖI 1: [HIGH] globalFee phân mảnh — 3 nơi, 3 giá trị khác nhau

**Trước:**
```
settings.monitoring.globalFeeThreshold = 0.5  (từ GLOBAL_FEE_THRESHOLD)
settings.rules.minGlobalFee = 0.3             (từ RULE_MIN_GLOBAL_FEE || GLOBAL_FEE_THRESHOLD)
global-fee-threshold.rule.js → minGlobalFee: 0.3  (hardcode)
```

**Sau:**
```
settings.monitoring.globalFeeThreshold = đọc RULE_MIN_GLOBAL_FEE || GLOBAL_FEE_THRESHOLD || 0.3
settings.rules.minGlobalFee = đọc RULE_MIN_GLOBAL_FEE || GLOBAL_FEE_THRESHOLD || 0.3
global-fee-threshold.rule.js → minGlobalFee: settings.rules.minGlobalFee  (từ settings)
```

Giờ cả hai đều đọc từ cùng 1 nguồn, mặc định giống nhau.

**Files sửa:** `settings.js`, `global-fee-threshold.rule.js`

---

## LỖI 2: [MED] dev-risk-check fallback sai

**Trước:** settings default 50, nhưng rule fallback 60:
```javascript
const maxScore = ctx.rule?.maxRiskScore || settings.rules.maxRiskScore || 60; // ← 60 sai
```

**Sau:** xoá hardcode, chỉ đọc từ settings:
```javascript
const maxScore = ctx.rule?.maxRiskScore || settings.rules.maxRiskScore;
```

**File sửa:** `dev-risk-check.rule.js`

---

## LỖI 3: [MED] same-buy-amount hardcode 10, không đọc settings

**Trước:** Rule không import settings, hardcode `tolerancePercent: 10`:
```javascript
module.exports = () => ({
  tolerancePercent: 10,  // hardcode
  evaluate: (ctx) => {
    const tolerance = (ctx.rule?.tolerancePercent || 10) / 100;  // fallback hardcode
```

**Sau:** Import settings, đọc `settings.rules.tolerancePercent`:
```javascript
const settings = require('../../../config/settings');
module.exports = () => ({
  tolerancePercent: settings.rules.tolerancePercent,
  evaluate: (ctx) => {
    const tolerance = (ctx.rule?.tolerancePercent || settings.rules.tolerancePercent) / 100;
```

**File sửa:** `same-buy-amount.rule.js`

---

## LỖI 4: [MED] listing-age-limit fallback hardcode 5

**Trước:**
```javascript
const max = ctx.rule?.maxMinutes || 5;  // bỏ qua settings
```

**Sau:**
```javascript
const max = ctx.rule?.maxMinutes || settings.rules.maxMinutes;
```

**File sửa:** `listing-age-limit.rule.js`

---

## LỖI 5: [MED] dev-hold-limit + bundle-limit init hardcode 20

**Trước:** Cả hai rule init `maxPercent: 20` thay vì đọc settings.

**Sau:**
```javascript
// dev-hold-limit
maxPercent: settings.rules.maxPercentDev,

// bundle-limit  
maxPercent: settings.rules.maxPercentBundle,
```

**Files sửa:** `dev-hold-limit.rule.js`, `bundle-limit.rule.js`

---

## LỖI 6: [MED] fresh-wallet-check deprecated nhưng vẫn tồn tại

**Trước:** File vẫn tồn tại, vẫn import, vẫn đăng ký (dù disabled), vẫn cấu hình trong profiles.

**Sau:** XOÁ HOÀN TOÀN:
- Xoá file `fresh-wallet-check.rule.js`
- Xoá import + đăng ký trong `rules/index.js`
- Xoá khỏi tất cả rule profiles
- Xoá `maxFreshCount` setting
- Cập nhật frontend labels

---

## LỖI 7: [MED] Xoá tất cả hardcoded fallback `|| <số>` thừa

Tất cả rules đã xoá pattern `|| <hardcoded_number>` ở cuối chuỗi fallback. Giá trị mặc định giờ chỉ đến từ `settings.js` — nguồn sự thật duy nhất.

**Rules đã sửa:** `top10-holder-limit`, `sybil-protection`, `volume-threshold`, `market-cap-check`, `cluster-detection`, `token-score-check`, `bonding-curve-progress`, `early-buyer-count-check`, `first-7-buyers-hold-limit`, `new-wallet-accumulation`

---

## QUY TẮC MỚI — MỌI RULE PHẢI TUÂN THỦ

```javascript
// ✅ ĐÚNG — init từ settings, evaluate đọc rule override hoặc settings
module.exports = () => ({
  id: 'example_rule',
  myParam: settings.rules.myParam,          // init từ settings
  evaluate: (ctx) => {
    const val = ctx.rule?.myParam || settings.rules.myParam;  // fallback settings
    // KHÔNG được || <hardcoded_number>
  },
});

// ❌ SAI
module.exports = () => ({
  myParam: 10,                               // hardcode
  evaluate: (ctx) => {
    const val = ctx.rule?.myParam || 10;     // hardcode fallback
  },
});
```

---

## DANH SÁCH FILES ĐÃ SỬA

| File | Thay đổi |
|------|---------|
| `settings.js` | Đồng bộ globalFeeThreshold, xoá maxFreshCount |
| `global-fee-threshold.rule.js` | Init từ settings, xoá hardcode |
| `dev-risk-check.rule.js` | Xoá fallback 60 |
| `same-buy-amount.rule.js` | Import settings, init + fallback từ settings |
| `listing-age-limit.rule.js` | Fallback từ settings |
| `dev-hold-limit.rule.js` | Init từ settings, xoá hardcode 20 |
| `bundle-limit.rule.js` | Init từ settings, xoá hardcode 20 |
| `top10-holder-limit.rule.js` | Xoá fallback hardcode |
| `sybil-protection.rule.js` | Xoá fallback hardcode |
| `volume-threshold.rule.js` | Xoá fallback hardcode |
| `market-cap-check.rule.js` | Xoá fallback hardcode |
| `cluster-detection.rule.js` | Xoá fallback hardcode |
| `token-score-check.rule.js` | Xoá fallback hardcode |
| `bonding-curve-progress.rule.js` | Xoá fallback hardcode |
| `early-buyer-count-check.rule.js` | Xoá fallback hardcode |
| `first-7-buyers-hold-limit.rule.js` | Xoá fallback hardcode |
| `new-wallet-accumulation.rule.js` | Xoá fallback hardcode |
| `rules/index.js` | Xoá fresh_wallet_check import + đăng ký |
| `rule-profiles/index.js` | Xoá fresh_wallet_check khỏi profiles |
| `app.js` | Cập nhật labels cho rule mới, xoá labels cũ |
