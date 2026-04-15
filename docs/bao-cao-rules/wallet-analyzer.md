# Thay đổi: wallet-analyzer.js

> File: `src/analyzers/wallet-analyzer.js`
> Dòng thay đổi: 65-68, 134

---

## Thay đổi

### Thêm `isFreshNewWallet` — Định nghĩa thống nhất ví mới

```javascript
// TRƯỚC: Chỉ có isNewWallet (quá lỏng)
const isNewWallet = txCount < 20 || walletAgeSeconds < 7 * 86400;

// SAU: Thêm isFreshNewWallet (chặt, dùng cho rules)
const isFreshNewWallet = (walletAgeSeconds < 10 * 3600) && txCount < 5;
const isNewWallet = isFreshNewWallet || txCount < 20 || walletAgeSeconds < 7 * 86400;
```

### Export `isFreshNewWallet` trong kết quả phân tích

Field mới `isFreshNewWallet` được thêm vào object trả về của `analyzeWallet()`, sẵn sàng cho tất cả rules sử dụng.

## Phân biệt các khái niệm

| Khái niệm | Tiêu chí | Mục đích |
|-----------|----------|----------|
| `isFreshNewWallet` | tuổi < 10h VÀ tx < 5 | **Dùng cho rules** — phát hiện ví mới toanh |
| `isNewWallet` | tx < 20 HOẶC tuổi < 7 ngày | **Dùng nội bộ** — quyết định có fetch funding data hay không (tối ưu RPC) |
| `isWhiteWallet` | tx <= 5 VÀ tuổi < 7 ngày VÀ 1 funding source | **Dùng cho cluster detection** — ví trắng organic |

## Tại sao không gộp hết thành 1?

- `isNewWallet` phải lỏng vì nó quyết định có tải thêm dữ liệu RPC hay không. Nếu chặt quá sẽ bỏ sót ví cần phân tích.
- `isWhiteWallet` phục vụ mục đích khác (cluster/insider detection), cần thêm điều kiện funding source.
- `isFreshNewWallet` là tiêu chí chặt nhất, dùng cho quyết định chặn/pass token.

## Tác động

- `new_wallet_accumulation` rule sử dụng `isFreshNewWallet` để xác định ví mới
- `fresh_wallet_check` (legacy) cũng đã cập nhật sang dùng `isFreshNewWallet`
- Các rule khác (`white_wallet_from_deployer`, `cluster_detection`) vẫn dùng `isWhiteWallet` — không bị ảnh hưởng
