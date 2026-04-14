import sqlite3
import json
import csv
import os
from datetime import datetime

# Đường dẫn database
DB_PATH = '/Users/votrungson/DATA CAPTAIN/SCAN SOL BOT/data/trades.db'
OUTPUT_PATH = '/Users/votrungson/DATA CAPTAIN/SCAN SOL BOT/token_analysis_report.csv'

def get_connection():
    return sqlite3.connect(DB_PATH)

def extract_rule_stats(rule_result_json):
    """Trích xuất kết quả các quy tắc từ JSON thành dictionary"""
    try:
        data = json.loads(rule_result_json)
        results = data.get('results', [])
        stats = {}
        for r in results:
            rule_id = r.get('ruleId')
            reason = r.get('reason', '')
            # Tên cột sẽ là "Rule: [Tên quy tắc]"
            rule_name = r.get('ruleName', rule_id)
            stats[f"Rule: {rule_name}"] = reason
        return stats
    except:
        return {}

def get_roi_at_5min(cursor, mint, entry_ts):
    """Tìm giá gần mốc 5 phút nhất để tính ROI"""
    # Mốc 5 phút sau khi vào lệnh (ms)
    target_ts = entry_ts + (5 * 60 * 1000)
    
    # Tìm trade gần mốc target nhất trong bảng trades
    # Lưu ý: bảng trades có cột timestamp và sol_amount, token_amount
    # Chúng ta ước tính mcap dựa trên (sol_amount / token_amount) * supply 
    # Nhưng vì bảng trades có thể không đủ dữ liệu mcap, ta sẽ tìm bản ghi simulator_positions nếu có
    # Hoặc dựa vào các bản ghi trade ghi nhận mcap (nếu có lưu)
    
    # Thử tìm trong simulator_positions trước (nếu có lịch sử cập nhật - ở đây giả định chỉ có entry/exit)
    # Vì simulator_positions chỉ lưu HIGHEST và CURRENT, ta sẽ dùng bảng trades để tìm giá biến động.
    
    # Lấy entry mcap từ simulator_positions hoặc passed_tokens
    cursor.execute("SELECT entry_market_cap_usd FROM simulator_positions WHERE mint = ? LIMIT 1", (mint,))
    res = cursor.fetchone()
    entry_mcap = res[0] if res else None
    
    if not entry_mcap:
        cursor.execute("SELECT launch_mcap_usd FROM passed_tokens WHERE mint = ? LIMIT 1", (mint,))
        res = cursor.fetchone()
        entry_mcap = res[0] if res else None

    # Nếu không có entry mcap thì không tính được ROI
    if not entry_mcap:
        return None, None

    # Tìm giao dịch gần mốc 5p nhất
    # Lưu ý: bảng trades trong bot này dường như chỉ lưu trade của BOT. 
    # Nếu muốn dữ liệu "Big Data", ta cần dựa vào các bản ghi scan lại (re-scans) trong token_scans
    cursor.execute("""
        SELECT created_at, launch_mcap_usd 
        FROM passed_tokens 
        WHERE mint = ?
    """, (mint,))
    # Thực tế passed_tokens chỉ lưu snapshot. Ta sẽ tìm trong token_scans các lần scan sau đó.
    
    cursor.execute("""
        SELECT timestamp, rule_result 
        FROM token_scans 
        WHERE mint = ? AND timestamp >= ? 
        ORDER BY ABS(timestamp - ?) ASC 
        LIMIT 1
    """, (mint, entry_ts, target_ts))
    
    row = cursor.fetchone()
    if row:
        scan_ts, rule_res = row
        # Trích xuất mcap hiện tại từ rule_result hoặc tokenData nếu có trong JSON
        # Tuy nhiên rule_result thường không chứa mcap trực tiếp mà là summary.
        # Chúng ta sẽ tìm mcap trong simulator_positions nếu status là CLOSED hoặc dựa trên current_mcap
        pass

    # Tạm thời trả về dữ liệu từ simulator_positions nếu có
    cursor.execute("SELECT current_market_cap_usd, highest_market_cap_sol, entry_market_cap_sol FROM simulator_positions WHERE mint = ?", (mint,))
    pos = cursor.fetchone()
    if pos:
        curr_mcap, high_sol, entry_sol = pos
        max_roi = (high_sol / entry_sol) if entry_sol and entry_sol > 0 else 0
        return None, max_roi # 5m ROI tạm để None nếu không có time-series
    
    return None, None

def main():
    print(f"Bắt đầu trích xuất dữ liệu từ {DB_PATH}...")
    conn = get_connection()
    cursor = conn.cursor()

    # 1. Lấy danh sách tất cả các token ELIGIBLE (Đã Pass)
    # Lấy bản ghi scan cuối cùng cho mỗi token để có thông số mới nhất
    query = """
    SELECT 
        s.mint, s.token_name, s.token_symbol, s.deployer, 
        s.dev_risk_score, s.token_score, s.cluster_detected, 
        s.rule_result, s.timestamp,
        p.launch_mcap_usd, p.highest_mcap_usd, p.current_mcap_usd,
        pos.entry_market_cap_usd, pos.highest_market_cap_sol, pos.entry_market_cap_sol,
        pos.status, pos.reason as exit_reason
    FROM token_scans s
    LEFT JOIN passed_tokens p ON s.mint = p.mint
    LEFT JOIN simulator_positions pos ON s.mint = pos.mint
    WHERE s.action_taken = 'ELIGIBLE'
    GROUP BY s.mint
    ORDER BY s.timestamp DESC
    """
    
    cursor.execute(query)
    rows = cursor.fetchall()
    print(f"Tìm thấy {len(rows)} token hợp lệ.")

    # Thu thập tất cả các tên cột Rule để làm header
    all_rule_columns = set()
    data_list = []

    for row in rows:
        (mint, name, symbol, deployer, dev_risk, token_score, cluster, 
         rule_result, ts, launch_mcap, high_mcap, curr_mcap,
         entry_mcap_pos, high_sol_pos, entry_sol_pos, pos_status, exit_reason) = row
        
        # Phân tích luật
        rule_stats = extract_rule_stats(rule_result)
        for col in rule_stats.keys():
            all_rule_columns.add(col)
            
        # Tính toán ROI
        max_roi = 0
        # Ưu tiên lấy từ simulator_positions vì nó chính xác hơn cho việc trade
        if entry_sol_pos and entry_sol_pos > 0:
            max_roi = high_sol_pos / entry_sol_pos
        elif launch_mcap and launch_mcap > 0 and high_mcap:
            max_roi = high_mcap / launch_mcap

        # Phân loại
        classification = "Other"
        if max_roi >= 3:
            classification = "Winner (x3+)"
        # Note: 5m drop cần time-series, tạm thời dùng exit_reason nếu là SL/Rug
        if exit_reason and ("STOP_LOSS" in exit_reason or "RUG" in exit_reason):
             classification = "Potential Rug/Loss"
        
        # Gom dữ liệu
        entry = {
            "Mint": mint,
            "Symbol": symbol,
            "Name": name,
            "Time (UTC)": datetime.fromtimestamp(ts/1000).strftime('%Y-%m-%d %H:%M:%S') if ts else "",
            "Deployer": deployer,
            "Dev Risk Score": dev_risk,
            "Token Score": token_score,
            "Cluster Detected": "Yes" if cluster else "No",
            "Launch Mcap USD": launch_mcap or entry_mcap_pos,
            "Peak Mcap USD": high_mcap,
            "Max ROI": round(max_roi, 2),
            "Classification": classification,
            "Position Status": pos_status or "Not Traded",
            "Exit Reason": exit_reason or ""
        }
        entry.update(rule_stats)
        data_list.append(entry)

    # 2. Xuất ra CSV
    rule_cols = sorted(list(all_rule_columns))
    headers = ["Mint", "Symbol", "Name", "Time (UTC)", "Classification", "Max ROI", 
               "Launch Mcap USD", "Peak Mcap USD", "Position Status", "Exit Reason",
               "Dev Risk Score", "Token Score", "Cluster Detected", "Deployer"] + rule_cols

    with open(OUTPUT_PATH, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for item in data_list:
            # Filter item to only include known headers
            filtered_item = {k: v for k, v in item.items() if k in headers}
            writer.writerow(filtered_item)

    print(f"Hoàn thành! File đã được lưu tại: {OUTPUT_PATH}")

if __name__ == "__main__":
    main()
