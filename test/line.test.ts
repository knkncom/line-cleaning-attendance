import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { isAllowedGroup, parseLineWebhook, verifyLineSignature } from '../src/line';
import { Env, LineWebhookEvent } from '../src/types';

// テスト用ヘルパー: 正しいHMAC-SHA256署名を計算してBase64で返す
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
    const invalidSignature = 'invalid-signature-value';
    const result = await verifyLineSignature(body, invalidSignature, secret);
    expect(result).toBe(false);
  });

  it('署名が null または空文字の場合は false を返すこと', async () => {
    expect(await verifyLineSignature(body, null, secret)).toBe(false);
    expect(await verifyLineSignature(body, '', secret)).toBe(false);
  });

  it('channelSecret が空文字の場合は false を返すこと', async () => {
    const validSignature = await calculateSignature(body, secret);
    expect(await verifyLineSignature(body, validSignature, '')).toBe(false);
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

  it('空配列の events をパースできること（検証用リクエスト）', () => {
    const raw = JSON.stringify({ events: [] });
    const parsed = parseLineWebhook(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.events).toEqual([]);
  });

  it('不正なJSON文字列の場合は null を返すこと', () => {
    expect(parseLineWebhook('{ invalid json')).toBeNull();
  });

  it('events プロパティがないオブジェクトの場合は null を返すこと', () => {
    expect(parseLineWebhook(JSON.stringify({ other: 123 }))).toBeNull();
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
    expect(isAllowedGroup(sampleEvent, '')).toBe(true);
  });

  it('設定されたグループIDと一致する場合は許可すること', () => {
    expect(isAllowedGroup(sampleEvent, 'target-group-001')).toBe(true);
  });

  it('設定されたグループIDと異なる場合は拒否すること', () => {
    expect(isAllowedGroup(sampleEvent, 'other-group-999')).toBe(false);
  });

  it('個人の1対1トークからのメッセージはグループID一致フィルタで拒否されること', () => {
    const userEvent: LineWebhookEvent = {
      type: 'message',
      webhookEventId: 'evt_user',
      timestamp: 1600000000000,
      source: {
        type: 'user',
        userId: 'U12345678',
      },
      deliveryContext: { isRedelivery: false },
    };
    expect(isAllowedGroup(userEvent, 'target-group-001')).toBe(false);
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

  it('GET /health で 200 OK とステータスを返すこと', async () => {
    const req = new Request('https://worker.local/health', { method: 'GET' });
    const res = await worker.fetch(req, dummyEnv, dummyCtx);
    expect(res.status).toBe(200);
    const data = await res.json() as { status: string; service: string };
    expect(data.status).toBe('ok');
    expect(data.service).toBe('line-cleaning-attendance');
  });

  it('署名ヘッダーがないPOSTリクエストは 401 を返すこと', async () => {
    const req = new Request('https://worker.local/webhook', {
      method: 'POST',
      body: JSON.stringify({ events: [] }),
    });
    const res = await worker.fetch(req, dummyEnv, dummyCtx);
    expect(res.status).toBe(401);
    const data = await res.json() as { error: string };
    expect(data.error).toContain('Missing x-line-signature');
  });

  it('署名が不正なPOSTリクエストは 401 を返すこと', async () => {
    const body = JSON.stringify({ events: [] });
    const req = new Request('https://worker.local/webhook', {
      method: 'POST',
      headers: {
        'x-line-signature': 'invalid-signature',
      },
      body,
    });
    const res = await worker.fetch(req, dummyEnv, dummyCtx);
    expect(res.status).toBe(401);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('Invalid signature');
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
    const text = await res.text();
    expect(text).toBe('OK');
  });
});
