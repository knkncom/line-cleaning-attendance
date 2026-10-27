/**
 * LINE Messaging API 関連ロジック (src/line.ts)
 * 
 * - Webhook署名検証 (HMAC-SHA256)
 * - イベント解析
 * - 送信元（グループID）検証
 * - LINEユーザーの表示名取得
 * - プライバシー・セキュリティに配慮した最小限のロギング
 */

import { LineUserProfile, LineWebhookEvent, LineWebhookPayload } from './types';

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
 */
export async function verifyLineSignature(
  rawBody: string,
  signature: string | null,
  channelSecret: string
): Promise<boolean> {
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
    console.error('[Security] 署名計算中にエラーが発生しました:', error instanceof Error ? error.message : 'Unknown');
    return false;
  }
}

/**
 * 生のリクエストボディをパースして LineWebhookPayload を取得します。
 */
export function parseLineWebhook(rawBody: string): LineWebhookPayload | null {
  try {
    const data = JSON.parse(rawBody);
    if (!data || typeof data !== 'object') {
      return null;
    }
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
 */
export function isAllowedGroup(
  event: LineWebhookEvent,
  allowedGroupId?: string
): boolean {
  if (!allowedGroupId || allowedGroupId.trim() === '') {
    return true;
  }
  const groupId = event.source.groupId || event.source.roomId;
  return groupId === allowedGroupId;
}

/**
 * LINEユーザーの表示名（ニックネーム）を取得します。
 * 
 * @param channelAccessToken LINEチャネルアクセストークン
 * @param userId LINE User ID
 * @param groupId 所属グループID（任意）
 */
export async function getLineUserProfile(
  channelAccessToken?: string,
  userId?: string,
  groupId?: string
): Promise<LineUserProfile | null> {
  if (!channelAccessToken || !userId) {
    return null;
  }

  try {
    // グループ内メンバープロファイルAPIを優先、失敗時は個別プロファイルAPIを試行
    const url = groupId
      ? `https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`
      : `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${channelAccessToken}`,
      },
    });

    if (!response.ok) {
      console.warn(`[LINE Profile] プロファイル取得失敗 (status: ${response.status})`);
      return null;
    }

    const profile = (await response.json()) as LineUserProfile;
    return profile;
  } catch (error) {
    console.error('[LINE Profile] 通信エラー:', error instanceof Error ? error.message : 'Unknown');
    return null;
  }
}

/**
 * プライバシー・セキュリティに配慮したイベント概要ログを出力します。
 * メッセージ全文や個人を特定する情報は出力しません。
 */
export function logEventSummary(event: LineWebhookEvent): void {
  const isRedelivery = event.deliveryContext?.isRedelivery ?? false;
  const sourceType = event.source?.type ?? 'unknown';
  const hasText = event.message?.type === 'text';

  console.log(
    `[LINE Event] type=${event.type}, eventId=${event.webhookEventId}, source=${sourceType}, hasText=${hasText}, redelivery=${isRedelivery}`
  );
}
