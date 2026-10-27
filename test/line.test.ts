import { describe, expect, it } from 'vitest';
import { parseAttendanceMessage } from '../src/attendance';
import worker from '../src/index';
import { isAllowedGroup, parseLineWebhook, verifyLineSignature } from '../src/line';
import { submitAttendanceToSheets } from '../src/sheets';
import { AttendanceSubmission, Env, LineWebhookEvent } from '../src/types';

// テスト用ヘルパー: 正しいHMAC-SHA256署名を計算
async function calculateSignature(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

describe('LINE Webhook Signature Verification', () => {
  const secret = 'test-channel-secret-12345';
  const body = JSON.stringify({
    destination: 'U1234567890',
    events: [],
  });

  it('正しい署名の場合は true を返すこと', async () => {
    const validSignature = await calculateSignature(body, secret);
    const result = await verifyLineSignature(body, validSignature, secret);
    expect(result).toBe(true);
  });

  it('本文が改ざんされた場合は false を返すこと', async () => {
    const validSignature = await calculateSignature(body, secret);
    const tamperedBody = JSON.stringify({
      destination: 'U1234567890',
      events: [{ type: 'malicious' }],
    });
    const result = await verifyLineSignature(tamperedBody, validSignature, secret);
    expect(result).toBe(false);
  });

  it('不正な署名の場合は false を返すこと', async () => {
    const result = await verifyLineSignature(body, 'invalid-signature-value', secret);
    expect(result).toBe(false);
  });

  it('署名が null または空文字の場合は false を返すこと', async () => {
    expect(await verifyLineSignature(body, null, secret)).toBe(false);
    expect(await verifyLineSignature(body, '', secret)).toBe(false);
  });
});

describe('LINE Webhook Payload Parser', () => {
  it('正しいJSON形式かつevents配列が存在する場合にパース成功すること', () => {
    const raw = JSON.stringify({
      events: [
        {
          type: 'message',
          webhookEventId: 'evt_123',
          timestamp: 1600000000000,
          source: { type: 'group', groupId: 'c123' },
          deliveryContext: { isRedelivery: false },
        },
      ],
    });
    const parsed = parseLineWebhook(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.events.length).toBe(1);
    expect(parsed?.events[0].webhookEventId).toBe('evt_123');
  });

  it('空配列の events をパースできること（接続検証リクエスト）', () => {
    const raw = JSON.stringify({ events: [] });
    const parsed = parseLineWebhook(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.events).toEqual([]);
  });

  it('不正なJSON文字列の場合は null を返すこと', () => {
    expect(parseLineWebhook('{ invalid json')).toBeNull();
  });
});

describe('Group ID Filtering', () => {
  const sampleEvent: LineWebhookEvent = {
    type: 'message',
    webhookEventId: 'evt_abc',
    timestamp: 1600000000000,
    source: {
      type: 'group',
      groupId: 'target-group-001',
    },
    deliveryContext: { isRedelivery: false },
  };

  it('allowedGroupId が未設定の場合は許可すること', () => {
    expect(isAllowedGroup(sampleEvent, undefined)).toBe(true);
  });

  it('設定されたグループIDと一致する場合は許可すること', () => {
    expect(isAllowedGroup(sampleEvent, 'target-group-001')).toBe(true);
  });

  it('設定されたグループIDと異なる場合は拒否すること', () => {
    expect(isAllowedGroup(sampleEvent, 'other-group-999')).toBe(false);
  });
});

describe('Attendance Message Parser (8:45 Deadline & Rule-based NLP)', () => {
  // 基準日: 2026-10-27
  const onTimeDate = new Date('2026-10-27T08:44:59+09:00'); // 8:44:59 (セーフ)
  const lateDate = new Date('2026-10-27T08:45:00+09:00');   // 8:45:00 (アウト)

  it('8:44:59までに「始めます」と投稿した場合は出席予定と判定すること', () => {
    const result = parseAttendanceMessage('始めます！', { referenceDate: onTimeDate });
    expect(result).not.toBeNull();
    expect(result?.status).toBe('出席予定');
    expect(result?.targetDate).toBe('2026-10-27');
  });

  it('8:44:59までに「はじめます」「掃除開始します」と投稿した場合は出席予定と判定すること', () => {
    expect(parseAttendanceMessage('はじめます', { referenceDate: onTimeDate })?.status).toBe('出席予定');
    expect(parseAttendanceMessage('掃除開始します', { referenceDate: onTimeDate })?.status).toBe('出席予定');
  });

  it('検証モード（デフォルト）では何時に投稿しても「始めます」が出席予定になること', () => {
    // 11:40現在でも出席予定になる
    const result = parseAttendanceMessage('始めます！', { referenceDate: lateDate });
    expect(result).not.toBeNull();
    expect(result?.status).toBe('出席予定');
    expect(result?.targetDate).toBe('2026-10-27');
  });

  it('enforceDeadline: true の場合、8:45:00以降に「始めます」と投稿した場合は遅刻（欠席扱い）と判定すること', () => {
    const result = parseAttendanceMessage('始めます！', { referenceDate: lateDate, enforceDeadline: true });
    expect(result).not.toBeNull();
    expect(result?.status).toBe('遅刻');
    expect(result?.reason).toContain('8:45:00以降');
  });

  it('朝「今日の掃除は休みます」と投稿した場合は欠席と判定すること', () => {
    const result = parseAttendanceMessage('今日の掃除は休みます', { referenceDate: onTimeDate });
    expect(result).not.toBeNull();
    expect(result?.status).toBe('欠席');
    expect(result?.targetDate).toBe('2026-10-27');
  });

  it('「出張のため不参加です」を出張と判定すること', () => {
    const result = parseAttendanceMessage('本日は出張です', { referenceDate: onTimeDate });
    expect(result).not.toBeNull();
    expect(result?.status).toBe('出張');
    expect(result?.targetDate).toBe('2026-10-27');
  });

  it('出欠と無関係な挨拶や雑談は null を返して無視すること', () => {
    expect(parseAttendanceMessage('了解です', { referenceDate: onTimeDate })).toBeNull();
    expect(parseAttendanceMessage('お疲れ様です', { referenceDate: onTimeDate })).toBeNull();
    expect(parseAttendanceMessage('おはようございます', { referenceDate: onTimeDate })).toBeNull();
  });
});

describe('Spreadsheet Client Integration', () => {
  it('SHEETS_WEBHOOK_URL未設定時は安全にスキップ（ローカルシミュレーション）すること', async () => {
    const dummyEnv: Env = {
      LINE_CHANNEL_SECRET: 'test-secret',
    };
    const submission: AttendanceSubmission = {
      targetDate: '2026-10-28',
      status: '出席予定',
      userId: 'U12345678',
      displayName: 'テスト太郎',
      rawText: '明日は参加します',
      eventId: 'evt_test_1',
      timestamp: 1600000000000,
    };
    const res = await submitAttendanceToSheets(dummyEnv, submission);
    expect(res.success).toBe(true);
    expect(res.action).toBe('skipped');
  });
});

describe('Worker HTTP Fetch Handler Integration', () => {
  const dummyEnv: Env = {
    LINE_CHANNEL_SECRET: 'test-secret',
    ALLOWED_LINE_GROUP_ID: 'c_clean_group',
    TZ: 'Asia/Tokyo',
  };

  const dummyCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  it('GET /health で 200 OK とダイレクトモードステータスを返すこと', async () => {
    const req = new Request('https://worker.local/health', { method: 'GET' });
    const res = await worker.fetch(req, dummyEnv, dummyCtx);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; mode: string };
    expect(data.status).toBe('ok');
    expect(data.mode).toBe('direct-to-sheets');
  });

  it('署名ヘッダーがないPOSTリクエストは 401 を返すこと', async () => {
    const req = new Request('https://worker.local/webhook', {
      method: 'POST',
      body: JSON.stringify({ events: [] }),
    });
    const res = await worker.fetch(req, dummyEnv, dummyCtx);
    expect(res.status).toBe(401);
  });

  it('LINEの接続検証リクエスト（空events配列）に正しい署名があれば 200 OK を返すこと', async () => {
    const body = JSON.stringify({ events: [] });
    const signature = await calculateSignature(body, dummyEnv.LINE_CHANNEL_SECRET);
    const req = new Request('https://worker.local/webhook', {
      method: 'POST',
      headers: {
        'x-line-signature': signature,
      },
      body,
    });
    const res = await worker.fetch(req, dummyEnv, dummyCtx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
  });

  it('出欠申告メッセージを含む正規Webhookリクエストを受け付けて 200 OK を返すこと', async () => {
    const body = JSON.stringify({
      events: [
        {
          type: 'message',
          webhookEventId: 'evt_attendance_1',
          timestamp: 1600000000000,
          source: {
            type: 'group',
            groupId: 'c_clean_group',
            userId: 'U999999',
          },
          deliveryContext: { isRedelivery: false },
          message: {
            id: 'msg_001',
            type: 'text',
            text: '明日の朝掃除は休みます',
          },
        },
      ],
    });
    const signature = await calculateSignature(body, dummyEnv.LINE_CHANNEL_SECRET);
    const req = new Request('https://worker.local/webhook', {
      method: 'POST',
      headers: {
        'x-line-signature': signature,
      },
      body,
    });
    const res = await worker.fetch(req, dummyEnv, dummyCtx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
  });
});
