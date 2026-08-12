import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { redactSecrets, ILinkClient } from '../src/ilink/client.js';
import { accountStatePath } from '../src/config.js';
import { DeliveryDiagnostics } from '../src/ilink/diagnostics.js';
import { OutboxStore } from '../src/ilink/outbox.js';
import { QuotaManager } from '../src/ilink/quota.js';
import type { Credentials } from '../src/ilink/types.js';

// ─── redactSecrets: never leak decryption keys / signed URLs into logs ───────

test('redactSecrets: masks aes_key / encrypt_query_param / full_url / url', () => {
  const input = {
    type: 2,
    image_item: {
      media: {
        aes_key: 'VERYSECRETKEY==',
        encrypt_query_param: 'sig=abc&t=1',
        full_url: 'https://cdn/x?token=zzz',
        encrypt_type: 1,
      },
    },
  };
  const out = redactSecrets(input) as any;
  assert.equal(out.image_item.media.aes_key, '***');
  assert.equal(out.image_item.media.encrypt_query_param, '***');
  assert.equal(out.image_item.media.full_url, '***');
  assert.equal(out.image_item.media.encrypt_type, 1, 'non-secret fields preserved');
});

test('redactSecrets: recurses through arrays and preserves structure', () => {
  const input = [{ url: 'http://a' }, { text_item: { text: 'hello' } }];
  const out = redactSecrets(input) as any[];
  assert.equal(out[0].url, '***');
  assert.equal(out[1].text_item.text, 'hello');
});

test('redactSecrets: leaves empty/missing secret values untouched', () => {
  const out = redactSecrets({ aes_key: '' }) as any;
  assert.equal(out.aes_key, ''); // nothing to redact
});

test('redactSecrets: is case-insensitive on key names', () => {
  const out = redactSecrets({ AES_KEY: 'x', Full_Url: 'http://y' }) as any;
  assert.equal(out.AES_KEY, '***');
  assert.equal(out.Full_Url, '***');
});

// ─── isFreshMessage: long-poll re-delivery de-dup ────────────────────────────

const DUMMY_CREDS: Credentials = {
  botToken: 't', baseUrl: 'https://example.com', ilinkBotId: 'b', ilinkUserId: 'u',
};

test('isFreshMessage: first sighting true, replay false', () => {
  const client = new ILinkClient(DUMMY_CREDS) as any;
  assert.equal(client.isFreshMessage('userA', 1001), true);
  assert.equal(client.isFreshMessage('userA', 1001), false);
  assert.equal(client.isFreshMessage('userA', 1002), true);
});

test('isFreshMessage: same numeric id from different users does NOT collide', () => {
  const client = new ILinkClient(DUMMY_CREDS) as any;
  assert.equal(client.isFreshMessage('userA', 5), true);
  assert.equal(client.isFreshMessage('userB', 5), true, "userB's message 5 is not a dup of userA's");
  assert.equal(client.isFreshMessage('userA', 5), false);
});

test('isFreshMessage: evicts oldest beyond the 1000-entry cap but keeps recent ones', () => {
  const client = new ILinkClient(DUMMY_CREDS) as any;
  for (let i = 0; i < 1000; i++) assert.equal(client.isFreshMessage('u', i), true);
  // Insert one more → the oldest key (u:0) is evicted.
  assert.equal(client.isFreshMessage('u', 1000), true);
  assert.equal(client.isFreshMessage('u', 0), true, 'evicted key is treated as fresh again');
  // A recently-seen key is still remembered.
  assert.equal(client.isFreshMessage('u', 999), false);
});

test('getUpdates stages the cursor until the returned messages are processed', async () => {
  const accountId = `poll-cursor-test-${Date.now()}`;
  const client = new ILinkClient({ ...DUMMY_CREDS, ilinkBotId: accountId }) as any;
  const originalFetch = globalThis.fetch;
  client.pollCursor = 'cursor-before';
  globalThis.fetch = async () => new Response(JSON.stringify({
    ret: 0,
    msgs: [{
      message_id: 1,
      from_user_id: 'user-a',
      to_user_id: 'bot-user',
      client_id: 'inbound-client-1',
      create_time_ms: Date.now(),
      message_type: 1,
      message_state: 0,
      context_token: 'context-a',
      item_list: [{ type: 1, text_item: { text: '0' } }],
    }],
    get_updates_buf: 'cursor-after',
    longpolling_timeout_ms: 30_000,
  }), { status: 200 });
  try {
    const messages = await client.getUpdates();

    assert.equal(messages.length, 1);
    assert.equal(client.pollCursor, 'cursor-before');
    assert.equal(client.pendingPollCursor, 'cursor-after');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(accountStatePath(accountId, 'poll_cursor.txt'), { force: true });
  }
});

test('getUpdates records returned inbound IDs and message types before processing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-poll-diagnostics-'));
  const accountId = `poll-diagnostics-${Date.now()}`;
  const originalFetch = globalThis.fetch;
  const diagnostics = new DeliveryDiagnostics(join(dir, 'delivery.jsonl'));
  const client = new ILinkClient(
    { ...DUMMY_CREDS, ilinkBotId: accountId },
    {
      accountId,
      diagnostics,
      outbox: new OutboxStore(join(dir, 'outbox.json')),
      quota: new QuotaManager(join(dir, 'quota.json'), accountId),
    },
  ) as any;
  client.pollCursor = 'cursor-before';
  globalThis.fetch = async () => new Response(JSON.stringify({
    ret: 0,
    msgs: [{
      message_id: 123,
      from_user_id: 'user-a',
      to_user_id: 'bot-user',
      client_id: 'inbound-client-1',
      create_time_ms: Date.now(),
      message_type: 1,
      message_state: 0,
      context_token: 'context-a',
      item_list: [{ type: 1, text_item: { text: '0' } }],
    }],
    get_updates_buf: 'cursor-after',
    longpolling_timeout_ms: 30_000,
  }), { status: 200 });

  try {
    await client.getUpdates();
    const line = JSON.parse(readFileSync(join(dir, 'delivery.jsonl'), 'utf8')) as Record<string, unknown>;
    assert.equal(line.event, 'poll');
    assert.equal(line.itemCount, 1);
    assert.deepEqual(line.messageTypes, [1]);
    assert.deepEqual(line.messageIdHashes, ['a665a4592042']);
    assert.equal(line.userHash, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(accountStatePath(accountId, 'poll_cursor.txt'), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps unsent activity durable after a final result and drains it on the next inbound', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-client-recovery-'));
  const accountId = `client-recovery-${Date.now()}`;
  const userId = 'user-recovery';
  const outbox = new OutboxStore(join(dir, 'outbox.json'), {
    maxItemsPerUser: 50,
    maxBytesPerUser: 100_000,
    finalReserveItems: 0,
    finalReserveBytes: 0,
  });
  const quota = new QuotaManager(join(dir, 'quota.json'), accountId, {
    maxItemsPerToken: 10,
    maxBytesPerToken: 100_000,
    maxItems: 50,
    maxBytes: 100_000,
    finalReserveItems: 0,
    finalReserveBytes: 0,
  });
  const client = new ILinkClient(
    { ...DUMMY_CREDS, ilinkBotId: accountId },
    { accountId, outbox, quota },
  ) as any;
  const sent: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { msg?: { item_list?: Array<{ text_item?: { text?: string } }> } };
    sent.push(body.msg?.item_list?.[0]?.text_item?.text || '');
    return new Response(JSON.stringify({ message_id: sent.length }), { status: 200 });
  };

  const inbound = (messageId: number, text: string, token: string): WeixinMessage => ({
    message_id: messageId,
    from_user_id: userId,
    to_user_id: 'bot-user',
    client_id: `inbound-${messageId}`,
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 0,
    context_token: token,
    item_list: [{ type: 1, text_item: { text } }],
  });

  try {
    await client.processMessage(inbound(1, '开始', 'token-a'));
    for (let i = 0; i < 8; i++) {
      const reservation = quota.reserve(userId, 1, 'activity');
      assert.equal(reservation.allowed, true);
      quota.commit(reservation.reservation.reservationId);
    }
    outbox.enqueueText({
      accountId,
      userId,
      generation: 1,
      tokenVersion: 1,
      priority: 'activity',
      text: '未发送的 Activity',
    });

    await client.sendText(userId, '最终结果', { priority: 'final' });
    const pendingBeforeInbound = outbox.listPending(userId, accountId);
    assert.ok(pendingBeforeInbound.some((item) => item.priority === 'activity'));

    await client.processMessage(inbound(2, '0', 'token-b'));

    assert.ok(sent.includes('最终结果'));
    assert.ok(sent.includes('未发送的 Activity'));
    assert.equal(outbox.listPending(userId, accountId).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('waits for an asynchronous message handler before completing the inbound receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-client-handler-'));
  const accountId = `client-handler-${Date.now()}`;
  const userId = 'user-handler';
  const quotaPath = join(dir, 'quota.json');
  const client = new ILinkClient(
    { ...DUMMY_CREDS, ilinkBotId: accountId },
    {
      accountId,
      outbox: new OutboxStore(join(dir, 'outbox.json')),
      quota: new QuotaManager(quotaPath, accountId),
    },
  ) as any;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  client.onMessage(async () => {
    markStarted();
    await gate;
  });

  const processing = client.processMessage({
    message_id: 1,
    from_user_id: userId,
    to_user_id: 'bot-user',
    client_id: 'inbound-client-1',
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 0,
    context_token: 'context-a',
    item_list: [{ type: 1, text_item: { text: '0' } }],
  });

  try {
    await started;
    const persisted = JSON.parse(readFileSync(quotaPath, 'utf8')) as any;
    const state = persisted.users[`${accountId}\u0000${userId}`];
    assert.deepEqual(state.pendingInboundIds, ['1']);
  } finally {
    release();
    await processing;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps an inbound pending when an asynchronous message handler fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-client-handler-failure-'));
  const accountId = `client-handler-failure-${Date.now()}`;
  const userId = 'user-handler-failure';
  const quotaPath = join(dir, 'quota.json');
  const client = new ILinkClient(
    { ...DUMMY_CREDS, ilinkBotId: accountId },
    {
      accountId,
      outbox: new OutboxStore(join(dir, 'outbox.json')),
      quota: new QuotaManager(quotaPath, accountId),
    },
  ) as any;
  client.onMessage(async () => {
    throw new Error('handler failed');
  });

  try {
    await assert.rejects(
      client.processMessage({
        message_id: 1,
        from_user_id: userId,
        to_user_id: 'bot-user',
        client_id: 'inbound-client-1',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-a',
        item_list: [{ type: 1, text_item: { text: '0' } }],
      }),
      /handler failed/,
    );
    const persisted = JSON.parse(readFileSync(quotaPath, 'utf8')) as any;
    const state = persisted.users[`${accountId}\u0000${userId}`];
    assert.deepEqual(state.pendingInboundIds, ['1']);
    assert.equal(state.seenInboundIds.includes('1'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
