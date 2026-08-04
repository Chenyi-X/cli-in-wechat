import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ILinkClient } from '../src/ilink/client.js';
import type { Credentials, WeixinMessage } from '../src/ilink/types.js';

const CREDS: Credentials = {
  botToken: 'token',
  baseUrl: 'https://example.test',
  ilinkBotId: 'account-a',
  ilinkUserId: 'bot-user',
};

function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'quota-v2-client-'));
  return { outboxPath: join(dir, 'outbox.json'), quotaPath: join(dir, 'quota.json') };
}

function message(id: number, uid = 'user-a', contextToken = 'context-token'): WeixinMessage {
  return {
    message_id: id,
    from_user_id: uid,
    to_user_id: 'bot-user',
    client_id: `inbound-${id}`,
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 0,
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  };
}

async function withFetchResponses(
  bodies: Array<Record<string, unknown> | string>,
  run: (requests: any[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
    const body = bodies.shift() ?? { ret: 0 };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('delivers thirteen queued final chunks as ten then three on the next inbound window', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const outbox = (client as any).outbox;
  for (let index = 0; index < 13; index += 1) {
    outbox.enqueue({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'final',
      itemId: `final-${index + 1}`,
      text: `chunk-${index + 1}`,
    });
  }

  await withFetchResponses(Array.from({ length: 13 }, () => ({ ret: 0 })), async (requests) => {
    const first = await client.recoverPending('user-a');
    assert.equal(first.filter((result: any) => result.status === 'sent').length, 10);
    assert.equal(requests.length, 10);
    assert.equal(outbox.listPending('user-a').length, 3);

    await (client as any).processMessage(message(2));
    assert.equal(requests.length, 13);
    assert.equal(outbox.listPending('user-a').length, 0);
  });
});

test('drains twenty-five queued chunks as ten, ten, and five across inbound windows', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const outbox = (client as any).outbox;
  for (let index = 0; index < 25; index += 1) {
    outbox.enqueue({
      accountId: 'account-a', userId: 'user-a', generation: 1, tokenVersion: 1,
      priority: 'final', itemId: `long-${index + 1}`, text: `chunk-${index + 1}`,
    });
  }

  await withFetchResponses(Array.from({ length: 25 }, () => ({ ret: 0 })), async (requests) => {
    await client.recoverPending('user-a');
    assert.equal(requests.length, 10);
    await (client as any).processMessage(message(2));
    assert.equal(requests.length, 20);
    await (client as any).processMessage(message(3));
    assert.equal(requests.length, 25);
    assert.equal(outbox.listPending('user-a').length, 0);
  });
});

test('ambiguous response keeps the frozen client id for the next recovery attempt', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const outbox = (client as any).outbox;
  outbox.enqueue({
    accountId: 'account-a', userId: 'user-a', generation: 1, tokenVersion: 1,
    priority: 'final', itemId: 'ambiguous-final', text: 'body',
  });

  await withFetchResponses([''], async (requests) => {
    const result = await client.recoverPending('user-a');
    assert.equal(result[0].status, 'ambiguous');
    assert.equal(outbox.listPending('user-a')[0].recoveryRequired, true);
    const firstClientId = requests[0].body.msg.client_id;

    await withFetchResponses([{ ret: 0 }], async (retryRequests) => {
      await (client as any).processMessage(message(2));
      assert.equal(retryRequests[0].body.msg.client_id, firstClientId);
      assert.equal(outbox.listPending('user-a').length, 0);
    });
  });
});

test('rate-limited ret=-2 stops the window without a second client retry', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  await withFetchResponses([{ ret: -2, errmsg: 'rate limited' }], async (requests) => {
    const result = await client.sendText('user-a', 'body');
    assert.equal(result[0].status, 'rate-limited');
    assert.equal(requests.length, 1);
    assert.equal((client as any).quota.snapshot('user-a').rateBackoffUntil > Date.now(), true);
  });
});

test('non-rate ret=-2 is ambiguous and remains durable for recovery', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  await withFetchResponses([{ ret: -2, errmsg: 'temporary scheduler failure' }], async (requests) => {
    const result = await client.sendText('user-a', 'body');
    assert.equal(result[0].status, 'ambiguous');
    assert.equal(requests.length, 1);
    assert.equal((client as any).outbox.listPending('user-a')[0].recoveryRequired, true);
  });
});

test('missing context token queues text without making a network request', async () => {
  const client = new ILinkClient(CREDS, paths());
  await withFetchResponses([], async (requests) => {
    const result = await client.sendText('user-a', 'queued body');
    assert.equal(result[0].status, 'waiting-for-token');
    assert.equal(requests.length, 0);
    assert.equal((client as any).outbox.listPending('user-a').length, 1);
  });
});
