# HƯỚNG DẪN TRIỂN KHAI CẬP NHẬT DEVELOPER_WORKFLOW.md (v2)

**Tài liệu này dành cho Antigravity**  
Mục đích: Hướng dẫn chi tiết, có thứ tự ưu tiên để cập nhật **DEVELOPER_WORKFLOW.md** cũ sang phiên bản mới, chuyên nghiệp và dễ scale hơn.

**Phiên bản:** 2.0  
**Ngày tạo:** 11/04/2026  
**Người soạn:** Grok (dựa trên phân tích DEVELOPER_WORKFLOW.md gốc)

---

## 1. Tóm tắt các thay đổi quan trọng (TL;DR)

Tài liệu gốc đã tốt (8/10). Bản cập nhật này sẽ nâng lên **9.5/10** bằng cách bổ sung:
- Event-Driven Architecture (Event Bus + Queue)
- Cooldown & Migration Handler
- Visual Architecture Diagram
- Dynamic Rule System
- Error Handling, Monitoring, Logging
- Security & Key Management
- PostgreSQL + Redis recommendation

---

## 2. Danh sách công việc cần làm (Ưu tiên cao → thấp)

| STT | Công việc cần thực hiện                              | Ưu tiên | Thời gian ước tính | Trạng thái |
|-----|------------------------------------------------------|---------|--------------------|------------|
| 1   | Thêm **Event Bus + BullMQ Queue**                    | ★★★★★   | 2 ngày             | ☐          |
| 2   | Thêm **Cooldown Queue & Migration Handler**          | ★★★★★   | 1 ngày             | ☐          |
| 3   | Vẽ **System Architecture Diagram** (mermaid hoặc Draw.io) | ★★★★    | 0.5 ngày           | ☐          |
| 4   | Tách folder `rules/` + Dynamic Rule Register         | ★★★★    | 1 ngày             | ☐          |
| 5   | Thay SQLite → PostgreSQL (hoặc giữ + Redis cache)    | ★★★★    | 2 ngày             | ☐          |
| 6   | Thêm Winston + Sentry logging & Monitoring           | ★★★     | 1 ngày             | ☐          |
| 7   | Viết phần **Security & Key Management**              | ★★★     | 0.5 ngày           | ☐          |
| 8   | Cập nhật đầy đủ **Error Handling & Retry Strategy**  | ★★★     | 1 ngày             | ☐          |
| 9   | Thêm **Fallback Matrix** cho nguồn dữ liệu          | ★★      | 0.5 ngày           | ☐          |
| 10  | Viết thêm phần **Testing & Deployment**             | ★★      | 1 ngày             | ☐          |

---

## 3. Chi tiết hướng dẫn từng thay đổi

### 3.1. Cấu trúc thư mục mới (sau khi update)
src/
├── core/
│   ├── orchestrator.js
│   ├── event-bus.js                 ← MỚI
│   ├── queue-manager.js             ← MỚI
│   ├── monitoring.js                ← MỚI
│   ├── pumpfun-detector.js
│   └── solana-connection.js
├── analyzers/
├── engine/
│   └── rule-engine.js
├── rules/                           ← MỚI (mỗi rule 1 file)
│   ├── rule-early-buyers.js
│   ├── rule-cabal-detection.js
│   └── ...
├── executor/
├── tracker/
├── web/
└── telegram/

### 3.2. Thay đổi cụ thể trong Vòng đời Token (Token Life Cycle)

**Thêm 3 giai đoạn mới:**

- **Bước 0.5 – Cooldown Queue**  
  Nếu token FAIL rule → push vào Cooldown (30 phút – 2 giờ). Không analyze lại trong thời gian này.

- **Bước 5.5 – Migration Handler**  
  Khi detect Bonding Curve hoàn thành → tự động:
  - Dừng PumpPortal listener
  - Chuyển sang Raydium Mode (DexScreener + Jupiter executor)

- **Bước 7 – TP/SL Manager**  
  Tách riêng file `tp-sl-manager.js` (không để sell-executor.js lo hết).

### 3.3. Thêm Rule mới (cách làm đúng chuẩn)

1. Tạo file trong thư mục `rules/`
2. Mỗi file export object:
   ```js
   module.exports = {
     id: "rule-cabal-required",
     type: "REQUIRE",
     name: "Bắt buộc phải có Cabal/Cluster",
     evaluate: (data, context) => { ... }
   }
   rule-engine.js sẽ tự scan folder rules/ và register động (không hardcode).
   3.4. Nguồn dữ liệu – Fallback Matrix (thêm vào phần 2)
   | Nguồn          | Primary            | Fallback               | Trigger                  |
|----------------|--------------------|------------------------|--------------------------|
| Token mới      | PumpPortal WS      | Helius Webhook         | WS disconnect > 5s       |
| Holders        | RPC batch          | Birdeye / DexScreener  | RPC 429                  |
| PnL update     | DexScreener        | Jupiter API            | -                        |
3.5. Security & Key Management (phần mới)

Private key phải được encrypt bằng crypto + dotenv
Jito tip: dynamic theo gas market (tối đa 0.01 SOL)
Không hardcode key trong code
Sử dụng node-keyv hoặc Redis để lưu session