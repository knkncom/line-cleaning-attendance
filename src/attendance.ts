/**
 * 出欠判定・日付解釈ロジック (src/attendance.ts)
 * 
 * - ルールベースの自然言語判定（外部有料API不使用、継続費用0円）
 * - 出欠に関係のない雑談や業務連絡は安全に無視 (null返却)
 * - 「今日」「明日」「明後日」「〇月〇日」などの日付表現を自動解釈
 */

import { AttendanceParsedResult } from './types';

export interface ParseAttendanceOptions {
  referenceDate?: Date; // 判定の基準日時（デフォルト: 現在時刻）
  timeZone?: string;     // タイムゾーン（デフォルト: Asia/Tokyo）
}

/**
 * 日本時間 (Asia/Tokyo) の YYYY-MM-DD 文字列を取得する補助関数
 */
function formatDateToJST(date: Date, offsetDays = 0): string {
  const target = new Date(date.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(target);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

/**
 * 日本時間 (Asia/Tokyo) の現在の時 (0-23) を取得
 */
function getJSTHour(date: Date): number {
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: 'numeric',
    hour12: false,
  });
  return parseInt(formatter.format(date), 10);
}

/**
 * テキストから出欠対象日 (YYYY-MM-DD) を抽出・推定
 */
export function extractTargetDate(text: string, referenceDate: Date = new Date()): string {
  // 1. 「明後日」「あさって」
  if (/明後日|あさって/i.test(text)) {
    return formatDateToJST(referenceDate, 2);
  }

  // 2. 「明日」「あした」「あす」
  if (/明日|あした|あす/i.test(text)) {
    return formatDateToJST(referenceDate, 1);
  }

  // 3. 「今日」「本日」「きょう」
  if (/今日|本日|きょう/i.test(text)) {
    return formatDateToJST(referenceDate, 0);
  }

  // 4. 「M/D」または「M月D日」のパターン
  const monthDayMatch = text.match(/(?:(\d{1,2})[月/])(\d{1,2})日?/);
  if (monthDayMatch) {
    const month = parseInt(monthDayMatch[1], 10);
    const day = parseInt(monthDayMatch[2], 10);
    const currentYear = parseInt(
      new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric' }).format(referenceDate),
      10
    );

    // 月と日の妥当性チェック
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const monthStr = month.toString().padStart(2, '0');
      const dayStr = day.toString().padStart(2, '0');
      return `${currentYear}-${monthStr}-${dayStr}`;
    }
  }

  // 5. 明示的な日付指定がない場合:
  // 夕方以降（15時以降）の申告は「明日の朝清掃」と推定、それ以前は「本日の朝清掃」と推定
  const currentHour = getJSTHour(referenceDate);
  if (currentHour >= 15) {
    return formatDateToJST(referenceDate, 1);
  } else {
    return formatDateToJST(referenceDate, 0);
  }
}

/**
 * メッセージ本文から出欠ステータスを判定します。
 * 出欠申告に該当しないメッセージ（一般的な挨拶・雑談等）は null を返します。
 * 
 * @param text 投稿されたメッセージ本文
 * @param options 判定オプション
 */
export function parseAttendanceMessage(
  text: string,
  options: ParseAttendanceOptions = {}
): AttendanceParsedResult | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const refDate = options.referenceDate ?? new Date();

  // --- パターン判定 ---

  // A. 訂正申告（「やっぱり参加」「やっぱり行けます」など、先行する欠席を覆す表現）
  if (/(やっぱり|都合がついたので|予定変更で).*(参加|出席|行け|行けそう|出られ)/i.test(trimmed)) {
    return {
      targetDate: extractTargetDate(trimmed, refDate),
      status: '出席予定',
      confidence: 'high',
      reason: '訂正による出席申告',
    };
  }

  // B. 欠席表現
  // 例: 「休みます」「お休みします」「欠席します」「参加できません」「行けません」
  const isAbsence = /(休みます|休ませて|欠席|お休み|休業|不参加|参加でき(?:ませ|ない)|行け(?:ませ|ない)|不都合)/i.test(
    trimmed
  );

  // C. 遅刻表現
  // 例: 「遅れます」「遅刻します」「電車遅延のため遅参」「少し遅れそう」
  const isLate = /(遅れ(?:ます|そう)|遅刻|遅参|遅延.*遅れ)/i.test(trimmed);

  // D. 出席予定表現
  // 例: 「参加します」「出席します」「行きます」「出られます」「向かいます」
  const isAttending = /(参加(?:します|予定)|出席|行きます|向かい(?:ます|中)|出られます)/i.test(trimmed);

  // E. 曖昧・要確認表現
  // 例: 「間に合いそう」「微妙です」「掃除どうですか」
  const isAmbiguous = /(間に合(?:う|いそう)|微妙|行けるかも|確認中)/i.test(trimmed);

  // 衝突または判定処理
  if (isAbsence) {
    // 欠席の文脈
    return {
      targetDate: extractTargetDate(trimmed, refDate),
      status: '欠席',
      confidence: 'high',
      reason: '欠席キーワード検知',
    };
  }

  if (isLate) {
    // 遅刻の文脈
    return {
      targetDate: extractTargetDate(trimmed, refDate),
      status: '遅刻',
      confidence: 'high',
      reason: '遅刻キーワード検知',
    };
  }

  if (isAttending) {
    // 出席の文脈
    return {
      targetDate: extractTargetDate(trimmed, refDate),
      status: '出席予定',
      confidence: 'high',
      reason: '出席予定キーワード検知',
    };
  }

  if (isAmbiguous) {
    // 曖昧表現
    return {
      targetDate: extractTargetDate(trimmed, refDate),
      status: '要確認',
      confidence: 'low',
      reason: '曖昧な表現のため目視確認が必要',
    };
  }

  // 出欠キーワードが一切含まれない通常の会話（雑談、業務連絡、あいさつ等）は無視
  return null;
}
