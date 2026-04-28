// Ngưỡng phân loại ví — siết chặt so với phiên bản v1 (10h/5tx quá lỏng).
// Cho phép env override để user tinh chỉnh không cần code.

module.exports = {
  // Định nghĩa "ví mới" thật sự — chỉ ví vừa tạo gần đây cho mục đích snipe/insider
  FRESH_WALLET: {
    // Tuổi tối đa (giây). Mặc định 1 giờ. (Cũ: 36000s = 10h — quá lỏng)
    maxAgeSeconds: parseInt(process.env.FRESH_WALLET_MAX_AGE_SEC || '3600', 10),
    // Số tx tối đa. Mặc định 2 (1 fund-in + 1 buy). (Cũ: 5 — quá lỏng)
    maxTxCount: parseInt(process.env.FRESH_WALLET_MAX_TX || '2', 10),
    // Số signatures fetch để xác định tuổi ví. Tăng từ 20 lên 100 để tránh
    // tính sai tuổi với ví bot active có > 20 tx/ngày.
    sigLookupLimit: parseInt(process.env.FRESH_WALLET_SIG_LIMIT || '100', 10),
  },

  // Peel-chain trace
  FUNDING_TRACE: {
    maxHops: parseInt(process.env.FUNDING_TRACE_MAX_HOPS || '5', 10),
    // Số funder tối đa per wallet để analyze (cũ: 1 — quá hẹp).
    maxFundersPerWallet: parseInt(process.env.FUNDING_TRACE_MAX_FUNDERS || '3', 10),
    // Cache TTL kết quả peel-chain (ms). Default 30 phút.
    cacheTtlMs: parseInt(process.env.FUNDING_TRACE_CACHE_TTL_MS || (30 * 60 * 1000), 10),
  },
};
