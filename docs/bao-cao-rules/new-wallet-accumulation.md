# Rule: new_wallet_accumulation

> Loại: BLOCK (chặn cứng)
> File: `src/engine/rules/buyers/new-wallet-accumulation.rule.js`
> Trạng thái: **MỚI — Bật mặc định**

---

## Mô tả

Phát hiện hành vi **tích trữ token bằng nhiều ví mới**. Chặn khi tất cả X ví mua đầu tiên đều là "ví mới" và tổng token nắm giữ vượt Y% tổng cung.

## Điều kiện CHẶN

```
CHẶN khi:
  1. Tất cả X ví mua đầu tiên đều là "ví mới" (isFreshNewWallet)
     - Ví mới = tuổi < 10 tiếng VÀ < 5 giao dịch
     - Ví bundle cũng tính là ví mới (nếu toggle bật)
  2. VÀ tổng token các ví đó nắm >= Y% tổng cung
```

## Tham số

| Tham số | ENV | Mặc định | Mô tả |
|---------|-----|----------|-------|
| checkFirstXBuyers (X) | `RULE_ACCUMULATION_CHECK_X` | 5 | Số ví đầu cần kiểm tra |
| maxAccumulationPercent (Y) | `RULE_ACCUMULATION_MAX_PCT` | 15% | Ngưỡng % supply |
| includeBundleAsNew | Dashboard toggle | true | Tính ví bundle là ví mới |

## Logic chi tiết

1. Lấy X ví mua đầu tiên từ `earlyBuyers`
2. Với mỗi ví, kiểm tra `isFreshNewWallet` (tuổi < 10h + tx < 5)
3. Nếu là ví bundle VÀ `includeBundleAsNew = true` → coi là ví mới
4. Nếu KHÔNG phải tất cả đều ví mới → **PASS**
5. Nếu tất cả đều ví mới → tính tổng tokenAmount / totalSupply
6. Nếu >= Y% → **CHẶN** (kèm chi tiết từng ví)
7. Nếu < Y% → **PASS** (cảnh báo nhẹ)

## Ví dụ output khi chặn

```
🚨 TẤT CẢ 5 ví mua đầu đều là VÍ MỚI và nắm 18.50% cung (> 15%)
  → A1b2c3...x7y8 | 2 txs | 1.5h tuổi | 5.20% cung
  → D4e5f6...z9w0 | 0 txs | 0.3h tuổi | 4.80% cung [BUNDLE]
  → ...
```

## Lý do tạo rule này

- Rule cũ `fresh_wallet_check` chỉ đếm số ví mới, không check % supply
- Rule cũ `first_7_buyers_hold_limit` check % supply nhưng không phân biệt ví mới/cũ
- Cần một rule KẾT HỢP cả hai tiêu chí để phát hiện hành vi tích trữ có chủ đích

## Giá trị trong profiles

| Profile | X | Y | Ghi chú |
|---------|---|---|---------|
| strict_current | 5 | 10% | Gắt nhất |
| balanced_backup3 | 5 | 15% | Cân bằng |
| loose_backup2 | 5 | 20% | Thoáng nhất |

## Lỗ hổng đã biết

Bot có thể dùng **ví cũ** (tạo trước > 10h, > 5 tx) để qua mặt rule này. Các rule `cluster_detection` và `same_buy_amount` có thể hỗ trợ phát hiện thêm.
