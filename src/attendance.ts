/**
 * 出欠判定・時刻締切ロジック (src/attendance.ts)
 * 
 * 【ルール仕様】
 * 1. 平日朝の朝清掃（8:45開始）を対象。
 * 2. 対象日は原則として「投稿日（当日）」。
 * 3. 締切時刻: 08:45:00 JST
 *    - 08:44:59.999 までの投稿: 「始めます」等があれば「出席予定 (◯)」
 *    - 08:45:00.000 以降の投稿: たとえ出席の意思があっても「遅刻（欠席扱い: ✕）」
 * 4. キーワード:
 *    - 出席: 「始めます」「はじめます」「開始」「参加」「やります」「行きます」「出られます」
 *    - 欠席: 「休みます」「欠席」「お休み」「行けません」「参加できません」
 *    - 出張: 「出張」
 */

import { AttendanceParsedResult } from './types';

export interface ParseAttendanceOptions {
  referenceDate?: Date; // 判定の基準日時（デフォルト: 現在時刻）
  timeZone?: string;     // タイムゾーン（デフォルト: Asia/Tokyo）
}

/**
 * 日本時間 (Asia/Tokyo) の YYYY-MM-DD 文字列を取得
 */
export function getJSTDateString(date: Date): string {
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

/**
 * 日本時間 (Asia/Tokyo) における「時 (0-23)」と「分 (0-59)」と「秒 (0-59)」を取得
 */
function getJSTTimeParts(date: Date): { hour: number; minute: number; second: number } {
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  const second = parseInt(parts.find((p) => p.type === 'second')?.value || '0', 10);
  return { hour, minute, second };
}

/**
 * 投稿時刻が 8:45:00 JST 以降かどうかを判定
 * 8:45:00.000 ちょうどを含むそれ以降は true (アウト)
 */
export function isLatePost(date: Date): boolean {
  const { hour, minute, second } = getJSTTimeParts(date);
  
  // 朝の判定（午前8時台45分以降、または午前9時以降）
  if (hour > 8) {
    return true;
  }
  if (hour === 8 && (minute > 45 || (minute === 45 && second >= 0))) {
    return true;
  }
  return false;
}

/**
 * メッセージ本文および投稿時刻から出欠ステータスを判定します。
 * 
 * @param text 投稿されたメッセージ本文
 * @param options 判定オプション（referenceDateに投稿時刻を渡す）
 */
export function parseAttendanceMessage(
  text: string,
  options: ParseAttendanceOptions = {}
): AttendanceParsedResult | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const postDate = options.referenceDate ?? new Date();
  const targetDate = getJSTDateString(postDate);
  const isAfterDeadline = isLatePost(postDate);

  // --- パターン判定 ---

  // 1. 出張表現
  if (/(出張|外回り|遠征)/i.test(trimmed)) {
    return {
      targetDate,
      status: '出張',
      confidence: 'high',
      reason: '出張申告検知',
    };
  }

  // 2. 明示的な欠席表現
  // 例: 「休みます」「お休みします」「欠席します」「参加できません」「行けません」
  const isAbsence = /(休みます|休ませて|欠席|お休み|休業|不参加|参加でき(?:ませ|ない)|行け(?:ませ|ない)|無理です)/i.test(
    trimmed
  );
  if (isAbsence) {
    return {
      targetDate,
      status: '欠席',
      confidence: 'high',
      reason: '欠席申告検知',
    };
  }

  // 3. 出席表現（「始めます」「開始」「参加」「やります」など）
  // 例: 「始めます」「はじめます」「掃除開始します」「やります」「参加します」「行きます」
  const isAttending = /(始め(?:ます|た)|はじめ(?:ます|た)|開始|やり(?:ます|ますー)|参加|出席|行きます|向かい(?:ます|中)|出られます)/i.test(
    trimmed
  );

  // 4. 明示的な遅刻表現
  // 例: 「遅れます」「電車遅延のため遅れます」
  const isExplicitLate = /(遅れ(?:ます|そう)|遅刻|遅参|遅延)/i.test(trimmed);

  if (isAttending) {
    // 8:45:00 以降の投稿は「遅刻（欠席扱い）」とする
    if (isAfterDeadline) {
      return {
        targetDate,
        status: '遅刻',
        confidence: 'high',
        reason: '8:45:00以降の投稿のため遅刻（欠席扱い）',
      };
    }

    // 8:44:59 までの投稿は「出席予定 (◯)」
    return {
      targetDate,
      status: '出席予定',
      confidence: 'high',
      reason: '8:45前の出席申告検知',
    };
  }

  if (isExplicitLate) {
    return {
      targetDate,
      status: '遅刻',
      confidence: 'high',
      reason: '遅刻申告検知（欠席扱い）',
    };
  }

  // 出欠と無関係な挨拶や業務連絡は無視
  return null;
}
