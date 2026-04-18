# Rule: `new_wallet_total_hold_limit`

> Phiên bản: v2.1 — Phòng tuyến cuối (final gate) cho ví mới

## Mục đích

Sau khi tất cả các rule khác đã PASS, kiểm tra **tổng % token mà các "ví mới" trong early buyers đang nắm**. Nếu vượt ngưỡng → CHẶN.

Bổ sung cho `new_wallet_accumulation` (chỉ chặn khi *tất cả* X ví đầu là ví mới). Rule này bắt được trường hợp ví mới **rải rác** nhưng tổng vẫn cao.

## Điều kiện

```
CHẶN nếu:
  Tổng tokenAmount của (ví mới trong earlyBuyers) / supply × 100 >= maxPercent
```

- **Ví mới**: `isFreshNewWallet === true` (tuổi < 10h VÀ < 5 tx)
- Tuỳ chọn: bundle wallet được tính như ví mới nếu `includeBundleAsNew = true`
- **Không yêu cầu** số ví mới tối thiểu — 1 ví mới mua mạnh cũng có thể trigger.

## Tham số

| Tham số | ENV | Mặc định | Mô tả |
|---------|-----|---------|-------|
| `maxPercent` | `RULE_NEW_WALLET_TOTAL_HOLD_MAX` | 15 | Ngưỡng % tổng cung tối đa |
| `includeBundleAsNew` | (config) | true | Có tính ví bundle vào ví mới không |

## Output (reason text)

| Tình huống | Reason |
|---|---|
| Không có ví mới | `0 ví mới trong N early buyers — chấp nhận` |
| Dưới ngưỡng | `M ví mới (trong N early buyers) nắm X.XX% cung (< Y%) — chấp nhận` |
| Vượt ngưỡng | `🚨 M VÍ MỚI (trong N early buyers) nắm X.XX% cung (>= Y%)` + chi tiết 7 ví |

`data` trả về: `{ newWalletCount, totalEarlyBuyers, percentHeld, maxPercent, wallets[] }`

## Vị trí thực thi

- **Cuối cùng** trong [`buildDefaultRules()`](../../src/engine/rules/index.js)
- Rule engine vẫn chạy hết tất cả rules (không short-circuit), nên rule này hiển thị ở cuối list kết quả phân tích
- Nếu có rule khác đã FAIL trước đó → token bị block bởi nhiều lý do, mỗi lý do hiển thị riêng

## Khác `new_wallet_accumulation`

| Tiêu chí | `new_wallet_accumulation` | `new_wallet_total_hold_limit` (rule mới) |
|---|---|---|
| Scope | X ví mua **đầu tiên** (default 5) | **TẤT CẢ** ví mới trong earlyBuyers |
| Yêu cầu | TẤT CẢ X ví đầu phải là ví mới | Không yêu cầu — đếm bất kỳ ví mới nào |
| Bắt được scenario | "Ví mới mua hàng loạt ở đầu" | "Ví mới rải rác nhưng tổng cao" |
| Threshold mặc định | 20% (Y) | 15% (maxPercent) |

Hai rule **bổ sung** cho nhau, không thay thế. Có thể double-block trong vài case nhưng reason khác nhau → user thấy được nguyên nhân.

## Edge cases

| Tình huống | Hành vi |
|---|---|
| `earlyBuyers` rỗng | PASS (không tới được vì rule khác chặn trước) |
| `holderStats.supply` invalid | PASS + warning (tránh chặn oan) |
| `tokenAmount` undefined | Coi như 0 |
| Bundle = ví mới + `includeBundleAsNew=false` | Bỏ qua bundle, chỉ tính `isFreshNewWallet` |

## Caveat: tokenAmount là HISTORIC

`earlyBuyerTrades.tokenAmount` = số token mua tại thời điểm T1, **không phải balance hiện tại**. Nếu ví đã bán → rule overestimate rủi ro. Hành vi này nhất quán với `first_7_buyers_hold_limit` và là conservative bias chấp nhận được.
