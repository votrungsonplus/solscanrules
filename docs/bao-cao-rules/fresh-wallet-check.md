# Rule: fresh_wallet_check

> Loại: ALERT (cảnh báo)
> File: `src/engine/rules/buyers/fresh-wallet-check.rule.js`
> Trạng thái: **LEGACY — Tắt mặc định**

---

## Thay đổi

### Trước (v1)

- **Bật mặc định**
- Định nghĩa ví mới: `walletAgeDays < 1` VÀ `firstTxTimestamp trong 2 giờ qua`
- Chỉ đếm số lượng ví mới, fail nếu > maxFreshCount

### Sau (v2)

- **Tắt mặc định** — đã được thay thế bởi `new_wallet_accumulation`
- Cập nhật sang định nghĩa thống nhất: `isFreshNewWallet` (tuổi < 10h + < 5 tx)
- Vẫn giữ lại để tương thích ngược, có thể bật lại nếu cần

## Lý do tắt

1. Rule mới `new_wallet_accumulation` **bao gồm hoàn toàn** logic phát hiện ví mới
2. Rule mới **tốt hơn** vì kết hợp thêm kiểm tra % supply (rule cũ không có)
3. Rule mới **nhận diện ví bundle** (rule cũ bỏ sót)
4. Chạy cả hai sẽ **trùng lặp** và gây nhầm lẫn cho người dùng

## Vấn đề phân mảnh đã sửa

Định nghĩa "ví mới" trong rule này trước đó **KHÁC** với `wallet-analyzer.js`:
- Rule cũ: age < 1 ngày + funded 2h → không check số tx
- wallet-analyzer `isNewWallet`: tx < 20 hoặc age < 7 ngày → quá lỏng
- wallet-analyzer `isWhiteWallet`: tx <= 5 + age < 7 ngày → khác tiêu chí

Giờ tất cả dùng chung `isFreshNewWallet`: **tuổi < 10 tiếng VÀ < 5 giao dịch**.

## Nếu muốn bật lại

```javascript
ruleEngine.updateRule('fresh_wallet_check', { enabled: true, maxFreshCount: 3 });
```

Lưu ý: Nếu bật cùng `new_wallet_accumulation`, hai rule sẽ đánh giá song song nhưng logic không xung đột (một là ALERT, một là BLOCK).
