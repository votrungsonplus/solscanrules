# Thay đổi: wallet-analyzer.js

> File: `src/analyzers/wallet-analyzer.js`
> Phiên bản: v3.0 — Chỉ còn 1 định nghĩa duy nhất

---

## Định nghĩa DUY NHẤT "ví mới" — isFreshNewWallet

```javascript
const isFreshNewWallet = (walletAgeSeconds !== null && walletAgeSeconds < 10 * 3600) && txCount < 5;
```

**Tiêu chí:**
- Tuổi ví **< 10 tiếng**
- Số giao dịch **< 5**

Hai điều kiện phải **đồng thời** thỏa mãn (AND).

---

## Các biến đã XOÁ

| Biến | Lý do xoá |
|------|-----------|
| `isNewWallet` | Quá lỏng (tx < 20 HOẶC age < 7 ngày), dùng làm gate fetch RPC nhưng đã thay bằng `isFreshNewWallet` |
| `isWhiteWallet` | Khái niệm riêng (tx <= 5 + age < 7 ngày + 1 funding source) đã hợp nhất vào `isFreshNewWallet` |
| `_checkWhiteWallet()` | Hàm tính `isWhiteWallet`, không còn cần thiết |

---

## Tác động theo tầng

### Gate fetch RPC (dòng 77)

```javascript
// TRƯỚC: isNewWallet = tx < 20 HOẶC age < 7 ngày → rất nhiều ví bị fetch
// SAU:   isFreshNewWallet = age < 10h VÀ tx < 5 → chỉ ví thực sự mới mới fetch
if (isFreshNewWallet) {
  // fetch fundingTxs, sourceOfFunds, recentTokensBought
}
// Ví cũ: bỏ qua hoàn toàn → tiết kiệm RPC đáng kể
```

> **Lưu ý**: `white_wallet_from_deployer` và `white_wallet_from_cex` giờ chỉ phát hiện ví mới toanh (< 10h). Ví deployer-funded nhưng > 10h tuổi sẽ không bị bắt bởi các rule này — nhưng `cluster_detection` và `same_buy_amount` vẫn có thể bắt.

### Funder analysis (phân tích ví nguồn tiền)

```javascript
// TRƯỚC: funderIsWhite = txCount <= 5 && age < 7 ngày
// SAU:   funderIsFresh = age < 10h && txCount < 5 (cùng tiêu chí isFreshNewWallet)
const funderIsFresh = funderAgeSeconds < 10 * 3600 && funderTxCount < 5;
return { isFreshNewWallet: funderIsFresh, label: funderIsFresh ? 'Ví mới' : 'Ví cũ' };
```

### Cluster detection

```javascript
// TRƯỚC: whiteWalletCount = analyses.filter(a => a.isWhiteWallet)
// SAU:   freshNewWalletCount = analyses.filter(a => a.isFreshNewWallet)
```

---

## Tất cả nơi dùng isFreshNewWallet

| File | Dùng để làm gì |
|------|---------------|
| `wallet-analyzer.js` | Khai báo + gate fetch RPC |
| `new-wallet-accumulation.rule.js` | Xác định ví mua đầu có phải ví mới không |
| `fresh-wallet-check.rule.js` (legacy) | Đếm ví mới trong early buyers |
| `white-wallet-from-deployer.rule.js` | Phát hiện ví mới được fund từ deployer |
| `white-wallet-from-cex.rule.js` | Đếm ví mới funded từ CEX |
| `token-scorer.js` | Tính điểm chất lượng early buyers |
| `app.js` (frontend) | Hiển thị badge "MỚI"/"CŨ" trên dashboard |
