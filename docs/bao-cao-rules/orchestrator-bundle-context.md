# Thay đổi: orchestrator.js — Truyền bundleWallets vào rule engine

> File: `src/core/orchestrator.js`
> Dòng thay đổi: ~1129-1139

---

## Thay đổi

### Trước

```javascript
const ruleResult = ruleEngine.evaluate({
  tokenData,
  earlyBuyers: buyerAnalyses,
  earlyBuyerTrades,
  clusterAnalysis,
  devAnalysis,
  tokenScore,
  bondingCurveProgress,
  holderStats,
  settings,
});
```

### Sau

```javascript
const ruleResult = ruleEngine.evaluate({
  tokenData,
  earlyBuyers: buyerAnalyses,
  earlyBuyerTrades,
  clusterAnalysis,
  devAnalysis,
  tokenScore,
  bondingCurveProgress,
  holderStats,
  bundleWallets,  // ← MỚI: Set() các địa chỉ ví bundle
  settings,
});
```

## Lý do

- `bundleWallets` (kiểu `Set<string>`) đã được tính ở bước 3 của pipeline phân tích (`_detectBundleWallets`)
- Trước đây nó chỉ được truyền vào `_fetchTokenHolders` để tính `bundleHoldPercent`
- Rule mới `new_wallet_accumulation` cần biết ví nào là bundle để tính chúng vào danh sách "ví mới"
- Không có bundleWallets trong context → rule mới không thể nhận diện ví bundle

## Tác động

- `new_wallet_accumulation`: Sử dụng `bundleWallets` để đánh dấu ví bundle là ví mới (khi toggle bật)
- Các rule khác: Không bị ảnh hưởng (chúng không đọc `ctx.bundleWallets`)
- `bundle_limit`: Vẫn hoạt động bình thường qua `holderStats.bundleHoldPercent`
