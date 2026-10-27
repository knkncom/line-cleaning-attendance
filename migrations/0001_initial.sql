-- =====================================================================
-- LINE朝清掃 出欠自動集計システム - 初期D1スキーマ定義 (0001_initial.sql)
-- =====================================================================

-- 1. 社員マスター
CREATE TABLE IF NOT EXISTS employees (
  employee_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  line_user_id TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

-- 2. 受信メッセージログ
-- 個人情報保護のため、出欠判定に必要な最小限のメッセージのみ保存し、長期保持は避ける設計
CREATE TABLE IF NOT EXISTS messages (
  event_id TEXT PRIMARY KEY,
  group_id TEXT,
  line_user_id TEXT,
  sent_at INTEGER NOT NULL,
  target_date TEXT,
  detected_status TEXT,
  confidence TEXT,
  review_reason TEXT,
  text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3. 出欠集計結果テーブル（target_date + employee_id で一意）
CREATE TABLE IF NOT EXISTS attendance (
  target_date TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  source_event_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_date, employee_id)
);

-- 4. スプレッドシート同期ログ
CREATE TABLE IF NOT EXISTS sync_runs (
  run_id TEXT PRIMARY KEY,
  target_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  error_summary TEXT
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(line_user_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(target_date);
