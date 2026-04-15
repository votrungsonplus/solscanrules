# Thay đổi: Rule Profiles

> File: `src/engine/rule-profiles/index.js`

---

## Thay đổi

### Tất cả 3 profiles đã được cập nhật:

1. **Thêm** `new_wallet_accumulation` vào mỗi profile
2. **Tắt** `fresh_wallet_check` trong mỗi profile (legacy)

### Chi tiết từng profile:

#### strict_current (Gắt nhất)

```javascript
fresh_wallet_check: { enabled: false },               // ← Tắt (trước: bật, maxFreshCount: 2)
new_wallet_accumulation: {                             // ← MỚI
  enabled: true,
  checkFirstXBuyers: 5,
  maxAccumulationPercent: 10,    // 10% — gắt nhất
  includeBundleAsNew: true
},
```

#### balanced_backup3 (Cân bằng)

```javascript
fresh_wallet_check: { enabled: false },               // ← Tắt (trước: bật, maxFreshCount: 4)
new_wallet_accumulation: {                             // ← MỚI
  enabled: true,
  checkFirstXBuyers: 5,
  maxAccumulationPercent: 15,    // 15% — cân bằng
  includeBundleAsNew: true
},
```

#### loose_backup2 (Thoáng)

```javascript
fresh_wallet_check: { enabled: false },               // ← Tắt (trước: bật, maxFreshCount: 4)
new_wallet_accumulation: {                             // ← MỚI
  enabled: true,
  checkFirstXBuyers: 5,
  maxAccumulationPercent: 20,    // 20% — thoáng nhất
  includeBundleAsNew: true
},
```

## Lý do chọn giá trị Y khác nhau

- **strict (10%)**: Chỉ 5 ví mới nắm > 10% supply đã là dấu hiệu tích trữ rõ ràng
- **balanced (15%)**: Cho phép early adoption tự nhiên ở mức vừa phải
- **loose (20%)**: Mở rộng để không bỏ lỡ kèo, chấp nhận rủi ro cao hơn
