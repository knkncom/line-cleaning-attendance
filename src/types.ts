/**
 * 型定義一覧 (src/types.ts)
 */

// -------------------------------------------------------------
// Cloudflare Workers 環境変数・バインディング
// -------------------------------------------------------------
export interface Env {
  /**
   * LINE Messaging API Channel Secret
   * Webhook署名（x-line-signature）のHMAC-SHA256検証に使用（必須シークレット）
   */
  LINE_CHANNEL_SECRET: string;

  /**
   * LINE Messaging API Channel Access Token（任意・推奨）
   * 投稿者のLINE表示名（ニックネーム）を取得するために使用
   */
  LINE_CHANNEL_ACCESS_TOKEN?: string;

  /**
   * 許可するLINEグループID（任意・推奨）
   * 設定されている場合、このグループID以外のイベントは無視・スキップします
   */
  ALLOWED_LINE_GROUP_ID?: string;

  /**
   * Google Apps Script (GAS) Webhook URL
   * スプレッドシートに直接書き込むためのエンドポイントURL
   */
  SHEETS_WEBHOOK_URL?: string;

  /**
   * Google Apps Script (GAS) 認証用共有シークレットトークン
   * GAS側でリクエストを検証し、部外者による不正書き込みを防止します
   */
  SHEETS_API_SECRET?: string;

  /**
   * タイムゾーン設定（デフォルト: "Asia/Tokyo"）
   */
  TZ?: string;
}

// -------------------------------------------------------------
// LINE Messaging API Webhook 型定義
// -------------------------------------------------------------
export interface LineWebhookPayload {
  destination?: string;
  events: LineWebhookEvent[];
}

export type LineSourceType = 'user' | 'group' | 'room';

export interface LineEventSource {
  type: LineSourceType;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineDeliveryContext {
  isRedelivery: boolean;
}

export interface LineTextMessage {
  id: string;
  type: 'text';
  text: string;
  quoteToken?: string;
}

export interface LineOtherMessage {
  id: string;
  type: string;
  [key: string]: unknown;
}

export type LineMessage = LineTextMessage | LineOtherMessage;

export interface LineWebhookEvent {
  type: 'message' | 'join' | 'leave' | 'memberJoined' | 'memberLeft' | 'follow' | 'unfollow' | string;
  mode?: 'active' | 'standby';
  timestamp: number;
  source: LineEventSource;
  webhookEventId: string;
  deliveryContext: LineDeliveryContext;
  message?: LineMessage;
  replyToken?: string;
}

export interface LineUserProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
  statusMessage?: string;
}

// -------------------------------------------------------------
// 出欠集計・スプレッドシート連携用型定義
// -------------------------------------------------------------
export type AttendanceStatus = '出席予定' | '欠席' | '遅刻' | '要確認';

export interface AttendanceParsedResult {
  targetDate: string; // YYYY-MM-DD
  status: AttendanceStatus;
  confidence: 'high' | 'medium' | 'low';
  reason?: string;
}

export interface AttendanceSubmission {
  targetDate: string;        // 対象日 (YYYY-MM-DD)
  status: AttendanceStatus;  // 出席予定 / 欠席 / 遅刻 / 要確認
  userId: string;            // LINE User ID
  displayName: string;       // LINE表示名（または不明時のフォールバック）
  rawText: string;           // 申告本文
  eventId: string;           // LINEイベントID（冪等性・重複排除用）
  timestamp: number;         // 投稿Unixタイムスタンプ
}

export interface SheetsSyncResponse {
  success: boolean;
  action?: 'updated' | 'inserted' | 'skipped';
  message?: string;
}
