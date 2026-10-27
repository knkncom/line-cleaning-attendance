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
   * 許可するLINEグループID
   * 設定されている場合、このグループID以外のイベントは無視・スキップします（任意・推奨）
   */
  ALLOWED_LINE_GROUP_ID?: string;

  /**
   * タイムゾーン設定（デフォルト: "Asia/Tokyo"）
   */
  TZ?: string;

  /**
   * Cloudflare D1 データベースバインディング（Phase 2で使用）
   */
  DB?: D1Database;

  /**
   * 出欠管理用GoogleスプレッドシートID（Phase 4で使用）
   */
  SHEET_ID?: string;

  /**
   * Googleサービスアカウントメールアドレス（Phase 4で使用）
   */
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;

  /**
   * Googleサービスアカウント秘密鍵（Phase 4で使用）
   */
  GOOGLE_PRIVATE_KEY?: string;
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

// -------------------------------------------------------------
// 出欠集計・データモデル型定義（後続フェーズ用）
// -------------------------------------------------------------
export type AttendanceStatus = '出席予定' | '欠席' | '遅刻' | '未申告' | '要確認';

export interface AttendanceParsedResult {
  targetDate: string; // YYYY-MM-DD
  status: AttendanceStatus;
  confidence: 'high' | 'medium' | 'low';
  reviewReason?: string;
}

export interface Employee {
  employeeId: string;
  displayName: string;
  lineUserId?: string | null;
  active: boolean;
}

export interface AttendanceRecord {
  targetDate: string;
  employeeId: string;
  status: AttendanceStatus;
  sourceEventId?: string | null;
  updatedAt: string;
}
