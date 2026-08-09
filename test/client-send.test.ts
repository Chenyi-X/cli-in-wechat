import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ILinkClient } from '../src/ilink/client.js';
import { OutboxStore } from '../src/ilink/outbox.js';
import { QuotaManager } from '../src/ilink/quota.js';
import { chunkUtf8Text } from '../src/ilink/text-chunk.js';
import type { Credentials, WeixinMessage } from '../src/ilink/types.js';
import {
  legacyFullChunkText,
  MIGRATED_BODY_BYTES,
  schemaTwoFailureFixture,
  schemaTwoMixedFailureFixture,
} from './fixtures/legacy-full-chunk.js';

const CREDS: Credentials = {
  botToken: 'token',
  baseUrl: 'https://example.test',
  ilinkBotId: 'account-a',
  ilinkUserId: 'bot-user',
};

function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'quota-v2-client-'));
  return {
    outboxPath: join(dir, 'outbox.json'),
    quotaPath: join(dir, 'quota.json'),
    diagnosticsPath: join(dir, 'delivery-diagnostics.jsonl'),
    contextTokensPath: join(dir, 'context_tokens.json'),
  };
}

function message(id: number, uid = 'user-a', contextToken = 'context-token', text = 'hello'): WeixinMessage {
  return {
    message_id: id,
    from_user_id: uid,
    to_user_id: 'bot-user',
    client_id: `inbound-${id}`,
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 0,
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }],
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

test('preserves the incident-shaped mixed-priority queue in fifo order during migration', async () => {
  const options = paths();
  const snapshot = schemaTwoMixedFailureFixture();
  writeFileSync(options.outboxPath, JSON.stringify(snapshot), 'utf8');
  const client = new ILinkClient(CREDS, options);

  await withFetchResponses(Array.from({ length: 10 }, () => ({ ret: 0 })), async (requests) => {
    await (client as any).processMessage(message(50, 'user-a', 'fresh-token', '继续'));

    assert.equal(requests.length, 9);
    const bodies = requests.map((request) => request.body.msg.item_list[0].text_item.text as string);
    const expectedBodies = Array.from({ length: 9 }, (_, index) => `legacy-intermediate-${index + 1}`);
    expectedBodies[8] += '\n\n后续内容已排队，请回复“继续”续发。';
    assert.deepEqual(bodies, expectedBodies);
    assert.ok(bodies.every((body) => Buffer.byteLength(body, 'utf8') <= 2_000));
    assert.ok(bodies[8].endsWith('\n\n后续内容已排队，请回复“继续”续发。'));
    assert.ok(!bodies.includes('后续内容已排队，请回复“继续”续发。'));

    const pending = client.getDeliveryStatus('user-a').pending;
    assert.deepEqual(pending.map((item) => item.itemId), [
      ...Array.from({ length: 19 }, (_, index) => `legacy-activity-${index + 1}`),
      ...Array.from({ length: 13 }, (_, index) => `legacy-${index + 1}`),
      'incident-control',
      'new-confirmation',
    ]);
    assert.equal(pending.filter((item) => item.priority === 'activity').length, 19);
    const confirmation = pending.find((item) => item.itemId === 'new-confirmation');
    assert.deepEqual(
      confirmation && {
        clientId: confirmation.clientId,
        generation: confirmation.generation,
        tokenVersion: confirmation.tokenVersion,
        priority: confirmation.priority,
        text: confirmation.text,
      },
      {
        clientId: 'new-confirmation-client',
        generation: 49,
        tokenVersion: 8,
        priority: 'final',
        text: '新会话',
      },
    );
    const control = pending.find((item) => item.itemId === 'incident-control');
    assert.deepEqual(
      control && {
        clientId: control.clientId,
        generation: control.generation,
        tokenVersion: control.tokenVersion,
        priority: control.priority,
        text: control.text,
      },
      {
        clientId: 'incident-control-client',
        generation: 41,
        tokenVersion: 6,
        priority: 'control',
        text: '保留控制消息',
      },
    );
    const persisted = JSON.parse(readFileSync(options.outboxPath, 'utf8'));
    assert.deepEqual(
      persisted.items.map((item: { itemId: string }) => item.itemId),
      pending.map((item) => item.itemId),
    );
  });
});

test('uses an injected quota window when migrating the default outbox', async () => {
  const options = paths();
  const snapshot = schemaTwoFailureFixture();
  snapshot.items = snapshot.items.slice(0, 8);
  snapshot.nextSequence = 9;
  writeFileSync(options.outboxPath, JSON.stringify(snapshot), 'utf8');
  const quota = new QuotaManager(options.quotaPath, 'account-a', { maxItemsPerWindow: 5 });
  const client = new ILinkClient(CREDS, { ...options, quota });

  await withFetchResponses(Array.from({ length: 5 }, () => ({ ret: 0 })), async (requests) => {
    await (client as any).processMessage(message(51, 'user-a', 'fresh-token', '继续'));

    assert.equal(requests.length, 5);
    const bodies = requests.map((request) => request.body.msg.item_list[0].text_item.text as string);
    assert.ok(bodies.every((body) => Buffer.byteLength(body, 'utf8') <= 2_000));
    assert.ok(bodies[4].endsWith('\n\n后续内容已排队，请回复“继续”续发。'));
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

test('keeps all streamed body chunks ahead of a final footer across windows', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const body = 'A'.repeat(MIGRATED_BODY_BYTES * 13 + 500);
  const chunks = chunkUtf8Text(body, MIGRATED_BODY_BYTES);
  assert.equal(chunks.length, 14);

  await withFetchResponses(Array.from({ length: 15 }, () => ({ ret: 0 })), async (requests) => {
    await client.sendText('user-a', body, { streamType: 'intermediate', priority: 'intermediate' });
    assert.equal(requests.length, 9);
    assert.deepEqual(
      requests.slice(0, 8).map((request) => request.body.msg.item_list[0].text_item.text),
      chunks.slice(0, 8),
    );
    assert.equal(
      requests[8].body.msg.item_list[0].text_item.text,
      `${chunks[8]}\n\n后续内容已排队，请回复“继续”续发。`,
    );

    await client.sendText('user-a', '— Codex | 30.0s', { priority: 'final' });
    assert.deepEqual(
      client.getDeliveryStatus('user-a').pending.map((item) => item.text),
      [...chunks.slice(9), '— Codex | 30.0s'],
    );

    await (client as any).processMessage(message(2, 'user-a', 'next-token', '继续'));
    assert.deepEqual(
      requests.slice(9).map((request) => request.body.msg.item_list[0].text_item.text),
      [...chunks.slice(9), '— Codex | 30.0s'],
    );
    assert.equal(client.getDeliveryStatus('user-a').pending.length, 0);
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

    await withFetchResponses([{ ret: 0 }], async (sameInboundRequests) => {
      await client.recoverPending('user-a');
      assert.equal(sameInboundRequests.length, 0);
      assert.equal(client.getDeliveryState('user-a').state, 'WAITING_INBOUND');
    });

    await withFetchResponses([{ ret: 0 }], async (retryRequests) => {
      await (client as any).processMessage(message(2));
      assert.equal(retryRequests[0].body.msg.client_id, firstClientId);
      assert.equal(outbox.listPending('user-a').length, 0);
    });
  });
});

test('HTTP success with an iLink message_id confirms delivery when ret is omitted', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));

  await withFetchResponses([{ message_id: 12345 }], async (requests) => {
    const result = await client.sendText('user-a', 'body');
    assert.equal(result[0].status, 'sent');
    assert.equal(requests.length, 1);
    assert.equal((client as any).outbox.listPending('user-a').length, 0);
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

test('activity holdback preserves fifo order when the final result arrives', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));

  await withFetchResponses(Array.from({ length: 10 }, () => ({ ret: 0 })), async (requests) => {
    for (let index = 0; index < 10; index += 1) {
      await client.sendText('user-a', `activity-${index + 1}`, { priority: 'activity' });
    }
    assert.equal(requests.length, 9);
    assert.match(requests[8].body.msg.item_list[0].text_item.text, /请回复“继续”续发。$/);

    await client.sendText('user-a', 'final-result', { priority: 'final' });
    assert.equal(requests.length, 9);
    assert.deepEqual(client.getDeliveryStatus('user-a').pending.map((item) => item.text), [
      'activity-10',
      'final-result',
    ]);

    await (client as any).processMessage(message(2, 'user-a', 'next-token', '继续'));
    assert.deepEqual(
      requests.slice(9).map((request) => request.body.msg.item_list[0].text_item.text),
      ['activity-10', 'final-result'],
    );
    assert.equal(client.getDeliveryStatus('user-a').pending.length, 0);
  });
});

test('configured window size limits delivery and leaves the suffix durable', async () => {
  const client = new ILinkClient(CREDS, { ...paths(), maxItemsPerWindow: 3 });
  await (client as any).processMessage(message(1));
  const outbox = (client as any).outbox as OutboxStore;
  for (let index = 0; index < 5; index += 1) {
    outbox.enqueue({
      accountId: 'account-a', userId: 'user-a', generation: 1, tokenVersion: 1,
      priority: 'final', itemId: `configured-${index + 1}`, text: `chunk-${index + 1}`,
    });
  }

  await withFetchResponses(Array.from({ length: 5 }, () => ({ ret: 0 })), async (requests) => {
    await client.recoverPending('user-a');
    assert.equal(requests.length, 3);
    assert.equal(client.getDeliveryStatus('user-a').quota.sentItems, 3);
    assert.equal(client.getDeliveryStatus('user-a').quota.maxItemsPerWindow, 3);
    assert.equal(client.getDeliveryStatus('user-a').pending.length, 2);
  });
});

test('a fresh inbound during an in-flight confirmed send does not relabel it ambiguous', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const originalFetch = globalThis.fetch;
  let releaseResponse!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  globalThis.fetch = (async () => {
    markStarted();
    await responseGate;
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  }) as typeof fetch;
  try {
    const sending = client.sendText('user-a', 'confirmed old generation');
    await started;
    const nextInbound = (client as any).processMessage(message(2));
    releaseResponse();

    const result = await sending;
    await nextInbound;
    assert.equal(result[0].status, 'sent');
    assert.equal(client.getDeliveryStatus('user-a').pending.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('an unconfirmed transport failure becomes ambiguous without an immediate retry', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw Object.assign(new Error('socket reset after write'), { code: 'ECONNRESET' });
  }) as typeof fetch;
  try {
    const result = await client.sendText('user-a', 'ambiguous transport');
    assert.equal(result[0].status, 'ambiguous');
    assert.equal(requests, 1);
    assert.equal(client.getDeliveryStatus('user-a').pending[0].recoveryRequired, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('sendText preserves an explicit task generation and exposes waiting state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-v2-client-injected-'));
  const outbox = new OutboxStore(join(dir, 'outbox.json'));
  const quota = new QuotaManager(join(dir, 'quota.json'), 'account-a');
  const client = new ILinkClient(CREDS, {
    outbox,
    quota,
    contextTokensPath: join(dir, 'context_tokens.json'),
    diagnosticsPath: join(dir, 'diagnostics.jsonl'),
  });

  const result = await client.sendText('user-a', 'durable task', { generation: 42, priority: 'final' });

  assert.equal(result[0].status, 'waiting-for-token');
  assert.equal(outbox.listPending('user-a')[0].generation, 42);
  assert.equal(client.getDeliveryState('user-a').state, 'WAITING_INBOUND');
});

test('a fresh inbound without a context token keeps the last usable token', async () => {
  const client = new ILinkClient(CREDS, paths());
  await (client as any).processMessage(message(1, 'user-a', 'token-a'));
  await (client as any).processMessage(message(2, 'user-a', ''));

  assert.equal(client.getContextToken('user-a'), 'token-a');
});

test('restart after the seventh confirmed chunk resumes the ambiguous item with the same client id', async () => {
  const options = paths();
  const first = new ILinkClient(CREDS, options);
  await (first as any).processMessage(message(1));
  const outbox = (first as any).outbox;
  for (let index = 0; index < 13; index += 1) {
    outbox.enqueue({
      accountId: 'account-a', userId: 'user-a', generation: 1, tokenVersion: 1,
      priority: 'final', itemId: `restart-seven-${index + 1}`, text: `chunk-${index + 1}`,
    });
  }

  const responses = [
    ...Array.from({ length: 7 }, () => ({ ret: 0 })),
    '',
    ...Array.from({ length: 6 }, () => ({ ret: 0 })),
  ];
  await withFetchResponses(responses, async (requests) => {
    const firstResult = await first.recoverPending('user-a');
    assert.equal(firstResult.filter((result) => result.status === 'sent').length, 7);
    assert.equal(firstResult.at(-1)?.status, 'ambiguous');
    const ambiguousClientId = requests[7].body.msg.client_id;

    const restarted = new ILinkClient(CREDS, options);
    await (restarted as any).processMessage(message(2));
    assert.equal(requests[8].body.msg.client_id, ambiguousClientId);
    assert.equal(restarted.getDeliveryStatus('user-a').pending.length, 0);
  });
});

test('restart after the tenth confirmed chunk resumes the remaining three', async () => {
  const options = paths();
  const first = new ILinkClient(CREDS, options);
  await (first as any).processMessage(message(1));
  const outbox = (first as any).outbox;
  for (let index = 0; index < 13; index += 1) {
    outbox.enqueue({
      accountId: 'account-a', userId: 'user-a', generation: 1, tokenVersion: 1,
      priority: 'final', itemId: `restart-ten-${index + 1}`, text: `chunk-${index + 1}`,
    });
  }

  await withFetchResponses(Array.from({ length: 13 }, () => ({ ret: 0 })), async (requests) => {
    await first.recoverPending('user-a');
    assert.equal(requests.length, 10);
    const restarted = new ILinkClient(CREDS, options);
    await (restarted as any).processMessage(message(2));
    assert.equal(requests.length, 13);
    assert.equal(restarted.getDeliveryStatus('user-a').pending.length, 0);
  });
});

test('restart reconciles a durable delivery receipt without resending', async () => {
  const options = paths();
  const outbox = new OutboxStore(options.outboxPath);
  const quota = new QuotaManager(options.quotaPath, 'account-a');
  const first = new ILinkClient(CREDS, { ...options, outbox, quota });
  await (first as any).processMessage(message(1));

  const commitDelivery = quota.commitDelivery.bind(quota);
  let simulateCrash = true;
  quota.commitDelivery = ((confirmation) => {
    if (simulateCrash) {
      simulateCrash = false;
      throw new Error('simulated crash before quota persistence');
    }
    return commitDelivery(confirmation);
  }) as typeof quota.commitDelivery;

  await withFetchResponses([{ ret: 0 }], async (requests) => {
    await assert.rejects(
      first.sendText('user-a', 'confirmed before crash'),
      (err: any) => err?.deliveryConfirmed === true
        && /simulated crash before quota persistence/.test(String(err.cause)),
    );
    assert.equal(requests.length, 1);
  });
  assert.ok(outbox.listPending('user-a')[0]?.deliveryReceipt);

  const restarted = new ILinkClient(CREDS, options);
  await withFetchResponses([], async (requests) => {
    await restarted.recoverPending('user-a');
    assert.equal(requests.length, 0);
  });
  assert.equal(restarted.getDeliveryStatus('user-a').pending.length, 0);
  assert.equal(restarted.getDeliveryStatus('user-a').quota.sentItems, 1);
  assert.equal(restarted.getDeliveryStatus('user-a').quota.remainingItems, 9);
});
