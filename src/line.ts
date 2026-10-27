/**
 * LINE Messaging API 関連ロジック (src/line.ts)
 * 
 * - Webhook署名検証 (HMAC-SHA256)
 * - イベント解析
 * - 送信元（グループID）検証
 * - セキュリティ・プライバシーに配慮した最小限のロギング
 */

import { LineWebhookEvent, LineWebhookPayload } from './types';

/**
 * タイミング攻撃を防ぐための安全な文字列比較（定数時間比較）
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * LINE Messaging API の Webhook署名（x-line-signature）を検証します。
 * 
 * 仕様:
 * - リクエスト本文（生テキスト）をチャネルシークレットを秘密鍵として HMAC-SHA256 ダイジェストを計算
 * - 計算結果のバイト列を Base64 エンコードした文字列と、x-line-signature を比較
 * 
 * @param rawBody 生のリクエスト本文（JSONパース前の生の文字列）
 * @param signature x-line-signature ヘッダーの値
 * @param channelSecret LINE Developersコンソールで発行されたチャネルシークレット
 * @returns 署名が一致すれば true、それ以外は false
 */
export async function verifyLineSignature(
  rawBody: string,
  signature: string | null,
  channelSecret: string
): Promise<boolean> {
  // 署名またはシークレットが空の場合は無条件で拒否
  if (!signature || !channelSecret || channelSecret.trim() === '') {
    return false;
  }

  try {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(channelSecret);
    const bodyData = encoder.encode(rawBody);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, bodyData);
    const computedSignature = btoa(
      String.fromCharCode(...new Uint8Array(signatureBuffer))
    );

    return timingSafeEqual(signature.trim(), computedSignature.trim());
  } catch (error) {
    // 署名計算時の例外は安全に拒否
    console.error('[Security] 署名計算中にエラーが発生しました:', error instanceof Error ? error.message : 'Unknown');
    return false;
  }
}

/**
 * 生のリクエストボディをパースして LineWebhookPayload を取得します。
 * 不正なJSONの場合は null を返します。
 */
export function parseLineWebhook(rawBody: string): LineWebhookPayload | null {
  try {
    const data = JSON.parse(rawBody);
    if (!data || typeof data !== 'object') {
      return null;
    }
    // events プロパティが配列であることを確認
    if (!Array.isArray(data.events)) {
      return null;
    }
    return data as LineWebhookPayload;
  } catch {
    return null;
  }
}

/**
 * イベントの送信元が許可されたグループかどうかを検証します。
 * 
 * @param event LINE Webhookイベント
 * @param allowedGroupId 許可するグループID（未設定の場合はtrueとして処理）
 */
export function isAllowedGroup(
  event: LineWebhookEvent,
  allowedGroupId?: string
): boolean {
  // 許可グループIDが未設定の場合は全グループ/チャットを受け入れる（ローカル検証・開発用）
  if (!allowedGroupId || allowedGroupId.trim() === '') {
    return true;
  }

  // グループまたはルーム以外からのイベントは対象外
  const groupId = event.source.groupId || event.source.roomId;
  return groupId === allowedGroupId;
}

/**
 * プライバシー・セキュリティに配慮したイベント概要ログを出力します。
 * メッセージ全文や個人を特定する情報は出力しません。
 */
export function logEventSummary(event: LineWebhookEvent): void {
  const isRedelivery = event.deliveryContext?.isRedelivery ?? false;
  const sourceType = event.source?.type ?? 'unknown';
  const hasText = event.message?.type === 'text';

  // 監査・デバッグに必要な最小限のメタデータのみ記録
  console.log(
    `[LINE Event] type=${event.type}, eventId=${event.webhookEventId}, source=${sourceType}, hasText=${hasText}, redelivery=${isRedelivery}`
  );
}
