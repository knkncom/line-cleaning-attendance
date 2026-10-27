/**
 * D1 データベース操作リポジトリ（Phase 2 用インターフェース・スケルトン） (src/repository.ts)
 */

import { AttendanceRecord, Employee, LineWebhookEvent } from './types';

export interface AttendanceRepository {
  /** イベントがすでに保存・処理済みかチェック */
  hasEventBeenProcessed(eventId: string): Promise<boolean>;

  /** Webhookイベントを保存 */
  saveMessageEvent(event: LineWebhookEvent): Promise<void>;

  /** LINE User ID から社員情報を取得 */
  findEmployeeByLineUserId(lineUserId: string): Promise<Employee | null>;

  /** 出欠レコードをUPSERT保存 */
  upsertAttendance(record: AttendanceRecord): Promise<void>;
}

/**
 * Cloudflare D1 実装（Phase 2 で本格実装）
 */
export class D1AttendanceRepository implements AttendanceRepository {
  constructor(private db?: D1Database) {}

  async hasEventBeenProcessed(eventId: string): Promise<boolean> {
    if (!this.db) return false;
    const stmt = this.db.prepare('SELECT 1 FROM messages WHERE event_id = ? LIMIT 1');
    const result = await stmt.bind(eventId).first();
    return result !== null;
  }

  async saveMessageEvent(event: LineWebhookEvent): Promise<void> {
    if (!this.db) return;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (event_id, group_id, line_user_id, sent_at, text)
      VALUES (?, ?, ?, ?, ?)
    `);
    const text = event.message?.type === 'text' ? event.message.text : null;
    await stmt
      .bind(
        event.webhookEventId,
        event.source.groupId || event.source.roomId || null,
        event.source.userId || null,
        event.timestamp,
        text
      )
      .run();
  }

  async findEmployeeByLineUserId(lineUserId: string): Promise<Employee | null> {
    if (!this.db) return null;
    const stmt = this.db.prepare(
      'SELECT employee_id, display_name, line_user_id, active FROM employees WHERE line_user_id = ? LIMIT 1'
    );
    const row = await stmt.bind(lineUserId).first<{
      employee_id: string;
      display_name: string;
      line_user_id: string | null;
      active: number;
    }>();

    if (!row) return null;

    return {
      employeeId: row.employee_id,
      displayName: row.display_name,
      lineUserId: row.line_user_id,
      active: row.active === 1,
    };
  }

  async upsertAttendance(record: AttendanceRecord): Promise<void> {
    if (!this.db) return;
    const stmt = this.db.prepare(`
      INSERT INTO attendance (target_date, employee_id, status, source_event_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(target_date, employee_id) DO UPDATE SET
        status = excluded.status,
        source_event_id = excluded.source_event_id,
        updated_at = excluded.updated_at
    `);
    await stmt
      .bind(
        record.targetDate,
        record.employeeId,
        record.status,
        record.sourceEventId || null,
        record.updatedAt
      )
      .run();
  }
}
