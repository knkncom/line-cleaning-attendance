/**
 * LINE朝清掃 出欠自動集計システム - メインエントリーポイント (src/index.ts)
 * 
 * Cloudflare Workers (TypeScript)
 * - fetch: LINE Webhook 受信およびヘルスチェック
 * - scheduled: 朝の定時集計 Cron Trigger (Phase 3/4)
 */

import { isAllowedGroup, logEventSummary, parseLineWebhook, verifyLineSignature } from './line';
import { D1AttendanceRepository } from './repository';
import { Env } from './types';

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

  /**
   * Cron Trigger 定時実行ハンドラー (Phase 3/4)
   */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log('[Cron] 出欠集計 Cron Trigger が起動しました');
    const tz = env.TZ || 'Asia/Tokyo';
    console.log(`[Cron] タイムゾーン: ${tz}`);
    // Phase 3 & Phase 4 にて出欠集計・スプレッドシート書き込みを実行
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

  // 6. 空イベント配列（LINE Developers コンソールの「検証」リクエスト）の処理
  if (payload.events.length === 0) {
    console.log('[Webhook] LINE Developers コンソールからの接続検証リクエストを受信しました (OK)');
    return new Response('OK', { status: 200 });
  }

  // 7. 各イベントの処理
  const repository = new D1AttendanceRepository(env.DB);

  for (const event of payload.events) {
    // 監査・デバッグ用最小限ログ（個人情報・本文は出力しない）
    logEventSummary(event);

    // 送信元グループの検証（許可グループIDが設定されている場合）
    if (!isAllowedGroup(event, env.ALLOWED_LINE_GROUP_ID)) {
      console.log(`[Filter] 許可されていないグループ/ソースからのイベントのためスキップ (eventId: ${event.webhookEventId})`);
      continue;
    }

    // 重複配信・再送イベントの確認
    if (event.deliveryContext?.isRedelivery) {
      console.log(`[Webhook] 再送イベントを検知 (eventId: ${event.webhookEventId})`);
    }

    // メッセージイベントの処理フック（バックグラウンドで安全に処理）
    if (event.type === 'message' && event.message?.type === 'text') {
      // D1が利用可能な場合は非同期で保存
      if (env.DB) {
        ctx.waitUntil(
          repository
            .hasEventBeenProcessed(event.webhookEventId)
            .then(async (alreadyProcessed) => {
              if (alreadyProcessed) {
                console.log(`[Repository] 処理済みイベントのため保存をスキップ: ${event.webhookEventId}`);
                return;
              }
              await repository.saveMessageEvent(event);
            })
            .catch((err) => {
              console.error('[Repository] メッセージ保存エラー:', err);
            })
        );
      }
    }
  }

  // LINEサーバーに対して迅速に 200 OK を返却
  return new Response('OK', { status: 200 });
}
