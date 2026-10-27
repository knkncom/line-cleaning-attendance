/**
 * 出欠判定ロジック（Phase 3 用インターフェース・スケルトン） (src/attendance.ts)
 * 
 * 仕様書の要件:
 * - 出席予定 / 欠席 / 遅刻 / 未申告 / 要確認 の状態判定
 * - ルールベース（キーワード、否定、訂正、日付表現）
 * - 有料AI APIを使用せず、継続費用0円を維持
 */

import { AttendanceParsedResult, AttendanceStatus } from './types';

export interface ParseAttendanceOptions {
  referenceDate?: Date; // 基準日（集計日時）
  timeZone?: string;     // タイムゾーン（Asia/Tokyo）
}

/**
 * 投稿メッセージから出欠ステータスおよび対象日を判定します。
 * （※ Phase 3 にて詳細な自然言語ルールを実装予定）
 */
export function parseAttendanceMessage(
  text: string,
  _options: ParseAttendanceOptions = {}
): AttendanceParsedResult | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  // 簡易キーワードマッチ（Phase 1 スケルトン実装）
  let status: AttendanceStatus = '要確認';
  let confidence: 'high' | 'medium' | 'low' = 'low';

  if (trimmed.includes('欠席') || trimmed.includes('休みます') || trimmed.includes('お休み')) {
    status = '欠席';
    confidence = 'high';
  } else if (trimmed.includes('遅れ') || trimmed.includes('遅刻')) {
    status = '遅刻';
    confidence = 'high';
  } else if (trimmed.includes('参加') || trimmed.includes('出席') || trimmed.includes('行きます')) {
    status = '出席予定';
    confidence = 'medium';
  }

  // 今日の日付 (YYYY-MM-DD)
  const todayStr = new Date().toISOString().slice(0, 10);

  return {
    targetDate: todayStr,
    status,
    confidence,
  };
}
