/**
 * Google スプレッドシート連携クライアント (src/sheets.ts)
 * 
 * Cloudflare Worker から Google Apps Script (GAS) Webアプリに HTTP POST し、
 * スプレッドシートへリアルタイムに出欠レコードを書き込みます（データベース不要）。
 */

import { AttendanceSubmission, Env, SheetsSyncResponse } from './types';

/**
 * 出欠申告データをGoogleスプレッドシート（GAS Webアプリ）へ送信します。
 * 
 * @param env 環境変数 (SHEETS_WEBHOOK_URL, SHEETS_API_SECRET)
 * @param submission 出欠申告データ
 */
export async function submitAttendanceToSheets(
  env: Env,
  submission: AttendanceSubmission
): Promise<SheetsSyncResponse> {
  const webhookUrl = env.SHEETS_WEBHOOK_URL;

  // Webhook URL が未設定の場合はローカルシミュレーションとして処理
  if (!webhookUrl || webhookUrl.trim() === '') {
    console.log(
      `[GoogleSheets:Simulate] SHEETS_WEBHOOK_URL 未設定のため送信をスキップ (対象日: ${submission.targetDate}, 状態: ${submission.status}, 社員/表示名: ${submission.displayName})`
    );
    return {
      success: true,
      action: 'skipped',
      message: 'SHEETS_WEBHOOK_URL is not configured',
    };
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // 認証シークレットが設定されている場合はヘッダーに付与
    if (env.SHEETS_API_SECRET) {
      headers['x-api-key'] = env.SHEETS_API_SECRET;
    }

    const payload = {
      apiKey: env.SHEETS_API_SECRET, // ヘッダーを剥がす環境へのフォールバック用
      targetDate: submission.targetDate,
      status: submission.status,
      userId: submission.userId,
      displayName: submission.displayName,
      rawText: submission.rawText,
      eventId: submission.eventId,
      timestamp: submission.timestamp,
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[GoogleSheets] 送信失敗 (HTTP ${response.status}): ${errText}`);
      return {
        success: false,
        message: `HTTP ${response.status}: ${errText}`,
      };
    }

    const result = (await response.json()) as SheetsSyncResponse;
    console.log(`[GoogleSheets] 反映完了: action=${result.action}, status=${submission.status}`);
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[GoogleSheets] 通信例外エラー:', errorMsg);
    return {
      success: false,
      message: errorMsg,
    };
  }
}
