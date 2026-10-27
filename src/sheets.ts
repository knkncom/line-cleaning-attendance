/**
 * Google スプレッドシート連携（Phase 4 用インターフェース・スケルトン） (src/sheets.ts)
 */

import { AttendanceRecord, Env } from './types';

export interface SheetsClient {
  /**
   * 出欠集計結果をスプレッドシートに反映（冪等なUPSERT更新）
   */
  syncAttendanceRecords(records: AttendanceRecord[]): Promise<{ updatedCount: number }>;
}

export class GoogleSheetsClient implements SheetsClient {
  protected env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async syncAttendanceRecords(records: AttendanceRecord[]): Promise<{ updatedCount: number }> {
    // Phase 4 にて Google Sheets API または Apps Script 連携を実装
    const sheetIdConfigured = Boolean(this.env.SHEET_ID);
    console.log(`[GoogleSheets] syncAttendanceRecords (件数: ${records.length}, sheetId設定済: ${sheetIdConfigured})`);
    return { updatedCount: records.length };
  }
}
