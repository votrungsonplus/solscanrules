# SCAN SOL BOT

Bot tự động phát hiện, phân tích và mua token mới trên PumpFun (Solana).

## Kiến trúc

```
src/
├── index.js                    # Entry point
├── config/
│   └── settings.js             # Configuration từ .env
├── core/
│   ├── solana-connection.js    # Solana RPC + wallet (multi-RPC failover)
│   ├── pumpfun-detector.js     # WebSocket listener phát hiện token mới
│   └── orchestrator.js         # Điều phối toàn bộ luồng bot
├── analyzers/
│   ├── wallet-analyzer.js      # Phân tích ví early buyer + cluster detection
│   ├── dev-analyzer.js         # Phân tích ví deployer + risk scoring
│   └── token-scorer.js         # Chấm điểm metadata token
├── engine/
│   └── rule-engine.js          # Rule engine linh hoạt (thêm/bớt điều kiện)
├── executor/
│   ├── buy-executor.js         # Mua token (Direct + Jito bundle)
│   └── sell-executor.js        # Bán token (TP/SL/Anti-rug)
├── telegram/
│   └── telegram-bot.js         # Telegram bot (alert + điều khiển)
├── tracker/
│   └── trade-tracker.js        # SQLite lưu lịch sử giao dịch + PnL
└── utils/
    ├── logger.js               # Pino logger
    └── helpers.js              # Utility functions
```

## Luồng hoạt động

1. **Detect** - PumpFun WebSocket phát hiện token mới tạo (real-time, sub-second)
2. **Monitor** - Theo dõi 5-10 early buyers đầu tiên trên bonding curve
3. **Analyze** - Phân tích song song:
   - Wallet history, source of funds, white wallet detection
   - Cluster detection (nhóm ví liên kết)
   - Dev risk scoring (lịch sử deployer)
   - Token metadata scoring
4. **Evaluate** - Rule engine kiểm tra tất cả điều kiện người dùng đặt
5. **Execute** - Tự động mua hoặc gửi alert Telegram chờ xác nhận
6. **Monitor Position** - Theo dõi TP/SL/Anti-rug cho position đã mua

## Rules có sẵn

| Rule | Type | Mô tả |
|------|------|--------|
| `white_wallet_from_deployer` | ALERT | Ví trắng nhận tiền từ deployer (insider) |
| `white_wallet_from_cex` | INFO | Ví trắng nhận tiền từ CEX (organic) |
| `same_buy_amount` | ALERT | Phát hiện ví mua cùng lượng SOL |
| `global_fee_threshold` | REQUIRE | Global fee đạt ngưỡng |
| `cluster_detection` | ALERT | Phát hiện cluster ví liên kết |
| `dev_risk_check` | ALERT | Risk score deployer quá cao |
| `token_score_check` | REQUIRE | Điểm metadata token đủ cao |
| `bonding_curve_progress` | INFO | % tiến trình bonding curve |

## Cài đặt

```bash
# 1. Install dependencies
npm install

# 2. Copy và cấu hình .env
cp .env.example .env
# Sửa .env với RPC URL, wallet key, Telegram token...

# 3. Chạy bot
npm start

# Hoặc dev mode (auto-restart)
npm run dev
```

## Telegram Commands

| Command | Mô tả |
|---------|--------|
| `/status` | Trạng thái bot, balance, PnL |
| `/positions` | Các position đang mở |
| `/pnl` | PnL hôm nay |
| `/rules` | Danh sách rules |
| `/toggle_rule <id>` | Bật/tắt rule |
| `/set_amount <sol>` | Đặt số SOL mua |
| `/set_tp <percent>` | Đặt take profit % |
| `/set_sl <percent>` | Đặt stop loss % |
| `/auto_buy <on\|off>` | Bật/tắt auto-buy |
| `/sell <mint>` | Force sell position |
| `/history` | Lịch sử giao dịch |
| `/pause` / `/resume` | Tạm dừng / tiếp tục bot |

## Tính năng

- Real-time token detection qua PumpFun WebSocket
- Multi-RPC failover (tự chuyển khi node chậm/down)
- Jito Bundle support (giao dịch nhanh hơn)
- Wallet analysis: history, source of funds, white wallet
- Cluster detection: phát hiện nhóm ví insider/cabal
- Dev risk scoring: phân tích lịch sử deployer
- Token metadata scoring
- Flexible rule engine (thêm/bớt điều kiện)
- Auto take-profit / stop-loss / anti-rug
- Telegram bot integration (alert + điều khiển)
- SQLite trade history + PnL tracking
- Daily loss limit protection
- Max concurrent positions limit
