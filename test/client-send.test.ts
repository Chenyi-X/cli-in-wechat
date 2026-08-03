import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ILinkClient } from '../src/ilink/client.js';
import { OutboxStore } from '../src/ilink/outbox.js';
import { QuotaManager } from '../src/ilink/quota.js';
import type { Credentials } from '../src/ilink/types.js';

const credentials: Credentials = {
  botToken: 'bot-token',
  baseUrl: 'https://example.test',
  ilinkBotId: 'account-a',
  ilinkUserId: 'bot-user',
};

function withStores(fn: (outbox: OutboxStore, quota: QuotaManager) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wxclient-'));
  const outbox = new OutboxStore(join(dir, 'outbox.json'));
  const quota = new QuotaManager(join(dir, 'quota.json'), 'account-a');
  return fn(outbox, quota).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('sendText queues durable text and reports waiting-for-token', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    (client as any).contextTokens.clear();

    const results = await client.sendText('user-a', '先等用户消息');

    assert.equal(results[0]?.status, 'waiting-for-token');
    assert.equal(client.getDeliveryState('user-a').state, 'WAITING_INBOUND');
    assert.equal(outbox.list('user-a').length, 1);
    assert.equal(quota.snapshot('user-a').sentItems, 0);
  });
});

test('sendText acknowledges only after sendmessage ret=0', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    const requests: RequestInit[] = [];
    globalThis.fetch = async (_input, init) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({ ret: 0, errcode: 0, errmsg: '' }), { status: 200 });
    };
    try {
      const results = await client.sendText('user-a', '已送达');

      assert.equal(results[0]?.status, 'sent');
      assert.deepEqual(outbox.list('user-a'), []);
      assert.equal(quota.snapshot('user-a').sentItems, 1);
      assert.equal(requests.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('ret=-2 is queued as an ambiguous rate limit without application retries', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ ret: -2, errcode: 17, errmsg: 'rate limited' }), { status: 200 });
    };
    try {
      const results = await client.sendText('user-a', '稍后继续', { priority: 'final' });

      assert.equal(results[0]?.status, 'rate-limited');
      assert.equal(results[0]?.error?.ret, -2);
      assert.equal(results[0]?.error?.errcode, 17);
      assert.equal(results[0]?.error?.errmsg, 'rate limited');
      assert.equal(client.getDeliveryState('user-a').state, 'RATE_BACKOFF');
      assert.equal(requestCount, 1);
      const pending = outbox.list('user-a');
      assert.equal(pending.length, 2);
      assert.equal(pending[0].priority, 'final');
      assert.equal(pending[1].priority, 'control');
      assert.match(pending[1].text, /新的消息后自动续发/);
      assert.equal(quota.snapshot('user-a').sentItems, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('sendImage reserves caption and image as one media request', async () => {
  await withStores(async (outbox, quota) => {
    const dir = mkdtempSync(join(tmpdir(), 'wxmedia-'));
    const imagePath = join(dir, 'image.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, any>> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/getuploadurl')) {
        return new Response(JSON.stringify({ upload_param: 'upload-param' }), { status: 200 });
      }
      if (url.includes('/c2c/upload')) {
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'download-param' } });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ret: 0, errcode: 0, errmsg: '' }), { status: 200 });
    };
    try {
      const results = await client.sendImage('user-a', imagePath, '图片说明');

      assert.equal(results[0]?.status, 'sent');
      assert.equal(quota.snapshot('user-a').sentItems, 1);
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].msg.item_list.length, 2);
      assert.equal(bodies[0].msg.item_list[0].text_item.text, '图片说明');
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a fresh inbound message drains the durable result and recovery notice', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      const payload = requestCount === 1
        ? { ret: -2, errcode: 17, errmsg: 'rate limited' }
        : { ret: 0, errcode: 0, errmsg: '' };
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    try {
      await client.sendText('user-a', '需要恢复的最终结果', { priority: 'final' });
      assert.equal(outbox.list('user-a').length, 2);

      await (client as any).processMessage({
        message_id: 2,
        from_user_id: 'user-a',
        to_user_id: 'bot-user',
        client_id: 'inbound-client-2',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-b',
        item_list: [{ type: 1, text_item: { text: '新消息' } }],
      });

      assert.equal(requestCount, 3);
      assert.deepEqual(outbox.list('user-a'), []);
      assert.equal(client.getDeliveryState('user-a').state, 'READY');
      assert.equal(client.getDeliveryState('user-a').waitingForInbound, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a final result supersedes stale intermediate text for the same generation', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    (client as any).contextTokens.clear();
    quota.recordInbound('user-a', 'message-1', 'context-a');
    outbox.enqueueText({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'intermediate',
      text: '过时的中间文本',
    });

    await client.sendText('user-a', '最终结果', { priority: 'final' });

    const pending = outbox.list('user-a');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].priority, 'final');
    assert.equal(pending[0].text, '最终结果');
  });
});
