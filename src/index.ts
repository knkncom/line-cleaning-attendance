/**
 * LINE朝清掃 出欠自動集計システム - メインエントリーポイント (src/index.ts)
 * 
 * Cloudflare Workers (TypeScript) - データベース不要のダイレクト連携版
 * 
 * - LINE Webhook 受信
 * - HMAC-SHA256 署名検証 & グループID検証
 * - メッセージ本文から出欠判定（出席予定/欠席/遅刻/要確認）
 * - Googleスプレッドシート（GAS Webアプリ）へリアルタイム直接反映
 */

import { parseAttendanceMessage } from './attendance';
import { getLineUserProfile, isAllowedGroup, logEventSummary, parseLineWebhook, verifyLineSignature } from './line';
import { submitAttendanceToSheets } from './sheets';
import { AttendanceSubmission, Env, LineWebhookEvent } from './types';

export default {
  /**
   * HTTP リクエストハンドラー
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ヘルスチェック用エンドポイント
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'line-cleaning-attendance',
          mode: 'direct-to-sheets',
          time: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // LINE Webhook 受信エンドポイント (POST / または POST /webhook)
    if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '/webhook')) {
      return handleWebhook(request, env, ctx);
    }

    // その他のパス・メソッドは 404
    return new Response('Not Found', { status: 404 });
  },
};

/**
 * LINE Messaging API Webhook リクエストを処理します。
 */
async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // 1. 署名ヘッダーの存在確認
  const signature = request.headers.get('x-line-signature');
  if (!signature) {
    console.warn('[Security] 署名ヘッダー (x-line-signature) が存在しません');
    return new Response(JSON.stringify({ error: 'Missing x-line-signature header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. チャネルシークレットの設定確認
  if (!env.LINE_CHANNEL_SECRET) {
    console.error('[Config Error] 環境変数 LINE_CHANNEL_SECRET が設定されていません');
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 3. 生のリクエスト本文の取得
  const rawBody = await request.text();

  // 4. HMAC-SHA256 署名検証
  const isValid = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
  if (!isValid) {
    console.warn('[Security] 不正な署名のリクエストを拒否しました');
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 5. JSON ペイロードの解析
  const payload = parseLineWebhook(rawBody);
  if (!payload) {
    console.warn('[Webhook] 不正なJSONペイロードを受信しました');
    return new Response(JSON.stringify({ error: 'Invalid payload' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 6. 空イベント配列（LINE Developers コンソールの接続検証）の処理
  if (payload.events.length === 0) {
    console.log('[Webhook] LINE Developers コンソールからの接続検証リクエストを受信しました (OK)');
    return new Response('OK', { status: 200 });
  }

  // 7. 各イベントの処理
  for (const event of payload.events) {
    // 監査・デバッグ用最小限ログ（個人情報・本文はログ出力しない）
    logEventSummary(event);

    // 送信元グループの検証
    if (!isAllowedGroup(event, env.ALLOWED_LINE_GROUP_ID)) {
      console.log(`[Filter] 許可されていないグループからのイベントのためスキップ (eventId: ${event.webhookEventId})`);
      continue;
    }

    // テキストメッセージイベントの処理
    if (
      event.type === 'message' &&
      event.message?.type === 'text' &&
      typeof event.message.text === 'string'
    ) {
      const text = event.message.text;

      // 出欠判定（出欠に関係ない雑談等は null が返る）
      const parsed = parseAttendanceMessage(text);
      if (!parsed) {
        // 出欠申告ではない通常のメッセージは処理不要
        continue;
      }

      console.log(
        `[Attendance Detected] status=${parsed.status}, targetDate=${parsed.targetDate}, reason=${parsed.reason}`
      );

      // バックグラウンドで非同期にスプレッドシートへ反映（LINEの応答タイムアウトを防止）
      ctx.waitUntil(processAttendanceEvent(env, event, text, parsed.status, parsed.targetDate));
    }
  }

  // LINEサーバーへ迅速に 200 OK を返却
  return new Response('OK', { status: 200 });
}

/**
 * 出欠申告イベントを処理し、Googleスプレッドシートへ送信します。
 */
async function processAttendanceEvent(
  env: Env,
  event: LineWebhookEvent,
  rawText: string,
  status: AttendanceSubmission['status'],
  targetDate: string
): Promise<void> {
  const userId = event.source.userId || 'unknown_user';
  const groupId = event.source.groupId || event.source.roomId;

  // LINE表示名の取得（アクセストークンがある場合）
  let displayName = userId.length > 8 ? `User_${userId.slice(-6)}` : userId;
  if (env.LINE_CHANNEL_ACCESS_TOKEN && event.source.userId) {
    const profile = await getLineUserProfile(
      env.LINE_CHANNEL_ACCESS_TOKEN,
      event.source.userId,
      groupId
    );
    if (profile?.displayName) {
      displayName = profile.displayName;
    }
  }

  const submission: AttendanceSubmission = {
    targetDate,
    status,
    userId,
    displayName,
    rawText,
    eventId: event.webhookEventId,
    timestamp: event.timestamp,
  };

  await submitAttendanceToSheets(env, submission);
}
