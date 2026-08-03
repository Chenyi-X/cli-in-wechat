import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ILinkClient } from '../src/ilink/client.js';
import { DeliveryDiagnostics } from '../src/ilink/diagnostics.js';
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

test('a fresh context token requeues output blocked by the local aggregate budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxclient-quota-recovery-'));
  const outbox = new OutboxStore(join(dir, 'outbox.json'));
  const quota = new QuotaManager(join(dir, 'quota.json'), 'account-a', {
    maxItems: 1,
    maxBytes: 100_000,
    finalReserveItems: 0,
    finalReserveBytes: 0,
  });
  const client = new ILinkClient(credentials, { outbox, quota });
  quota.recordInbound('user-a', 'message-1', 'context-a');
  (client as any).contextTokens.set('user-a', 'context-a');

  const originalFetch = globalThis.fetch;
  const payloads: Array<Record<string, any>> = [];
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  };
  try {
    await client.sendText('user-a', '第一条');
    const blocked = await client.sendText('user-a', '新 token 后必须恢复的最终结果', { priority: 'final' });

    assert.equal(blocked[0]?.status, 'queued');
    const blockedItem = outbox.list('user-a').find((item) => item.text === '新 token 后必须恢复的最终结果');
    assert.equal(blockedItem?.state, 'pending');

    await (client as any).processMessage({
      message_id: 2,
      from_user_id: 'user-a',
      to_user_id: 'bot-user',
      client_id: 'inbound-client-2',
      create_time_ms: Date.now(),
      message_type: 1,
      message_state: 0,
      context_token: 'context-b',
      item_list: [{ type: 1, text_item: { text: '0' } }],
    });

    assert.deepEqual(
      payloads.map((payload) => payload.msg.item_list[0].text_item.text),
      ['第一条', '新 token 后必须恢复的最终结果'],
    );
    assert.deepEqual(outbox.list('user-a'), []);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh context token requeues legacy local quota failures', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');
    const item = outbox.enqueueText({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'final',
      text: '旧版本留下的最终结果',
    });
    outbox.markPermanentFailure(item.itemId, { errmsg: '本地发送预算不足: budget-exhausted' });

    const originalFetch = globalThis.fetch;
    const payloads: Array<Record<string, any>> = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    };
    try {
      await (client as any).processMessage({
        message_id: 2,
        from_user_id: 'user-a',
        to_user_id: 'bot-user',
        client_id: 'inbound-client-2',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-b',
        item_list: [{ type: 1, text_item: { text: '0' } }],
      });

      assert.deepEqual(payloads.map((payload) => payload.msg.item_list[0].text_item.text), ['旧版本留下的最终结果']);
      assert.deepEqual(outbox.list('user-a'), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a fresh inbound requeues legacy temporary local quota failures', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');
    const item = outbox.enqueueText({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'final',
      text: '旧版本暂时预算失败后仍要恢复的最终结果',
    });
    outbox.markPermanentFailure(item.itemId, { errmsg: '本地发送预算暂时不足: final-reserved' });

    const originalFetch = globalThis.fetch;
    const payloads: Array<Record<string, any>> = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    };
    try {
      await (client as any).processMessage({
        message_id: 2,
        from_user_id: 'user-a',
        to_user_id: 'bot-user',
        client_id: 'inbound-client-2',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-b',
        item_list: [{ type: 1, text_item: { text: '0' } }],
      });

      assert.deepEqual(
        payloads.map((payload) => payload.msg.item_list[0].text_item.text),
        ['旧版本暂时预算失败后仍要恢复的最终结果'],
      );
      assert.deepEqual(outbox.list('user-a'), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a new inbound requeues legacy local quota failures even when the token is unchanged', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');
    const item = outbox.enqueueText({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'final',
      text: '同 token 下也必须恢复的最终结果',
    });
    outbox.markPermanentFailure(item.itemId, { errmsg: '本地发送预算不足: budget-exhausted' });

    const originalFetch = globalThis.fetch;
    const payloads: Array<Record<string, any>> = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    };
    try {
      await (client as any).processMessage({
        message_id: 2,
        from_user_id: 'user-a',
        to_user_id: 'bot-user',
        client_id: 'inbound-client-2',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-a',
        item_list: [{ type: 1, text_item: { text: '0' } }],
      });

      assert.deepEqual(
        payloads.map((payload) => payload.msg.item_list[0].text_item.text),
        ['同 token 下也必须恢复的最终结果'],
      );
      assert.deepEqual(outbox.list('user-a'), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a restarted client recovers local quota failures after an inbound already arrived', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxclient-restart-recovery-'));
  const outboxPath = join(dir, 'outbox.json');
  const quotaPath = join(dir, 'quota.json');
  const originalFetch = globalThis.fetch;
  try {
    const firstOutbox = new OutboxStore(outboxPath);
    const firstQuota = new QuotaManager(quotaPath, 'account-a');
    firstQuota.recordInbound('user-a', 'message-1', 'context-a');
    const item = firstOutbox.enqueueText({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'final',
      text: '进程重启后仍要恢复的最终结果',
    });
    firstOutbox.markPermanentFailure(item.itemId, { errmsg: '本地发送预算不足: budget-exhausted' });

    // Simulate the old process receiving the recovery message and persisting its
    // newer inbound context before it exits.
    firstQuota.recordInbound('user-a', 'message-2', 'context-b');

    const restartedOutbox = new OutboxStore(outboxPath);
    const restartedQuota = new QuotaManager(quotaPath, 'account-a');
    const restarted = new ILinkClient(credentials, { outbox: restartedOutbox, quota: restartedQuota });
    (restarted as any).contextTokens.set('user-a', 'context-b');

    const payloads: Array<Record<string, any>> = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    };

    await (restarted as any).drainStartupRecovery();

    assert.deepEqual(
      payloads.map((payload) => payload.msg.item_list[0].text_item.text),
      ['进程重启后仍要恢复的最终结果'],
    );
    assert.deepEqual(restartedOutbox.list('user-a'), []);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendmessage diagnostics survive process log rotation and preserve response metadata', async () => {
  await withStores(async (outbox, quota) => {
    const dir = mkdtempSync(join(tmpdir(), 'wxclient-diagnostics-'));
    const diagnostics = new DeliveryDiagnostics(join(dir, 'delivery.jsonl'));
    const client = new ILinkClient(credentials, { outbox, quota, diagnostics });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ret: -2, errcode: 17, errmsg: 'prepare failed', message_id: 12345 }),
      { status: 200 },
    );
    try {
      await client.sendText('user-a', '诊断正文不应落盘');

      const records = readFileSync(join(dir, 'delivery.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(records.length, 2);
      assert.equal(records[0]?.event, 'request');
      assert.equal(records[1]?.event, 'response');
      assert.deepEqual(records[1]?.response, {
        ret: -2,
        errcode: 17,
        errmsg: 'prepare failed',
        messageId: 12345,
        httpStatus: 200,
      });
      assert.equal(JSON.stringify(records).includes('诊断正文不应落盘'), false);
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('keeps a message durable when HTTP 200 does not confirm delivery', async () => {
  await withStores(async (outbox, quota) => {
    const dir = mkdtempSync(join(tmpdir(), 'wxclient-unconfirmed-diagnostics-'));
    const diagnostics = new DeliveryDiagnostics(join(dir, 'delivery.jsonl'));
    const client = new ILinkClient(credentials, { outbox, quota, diagnostics });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
    try {
      const results = await client.sendText('user-a', '必须保留直到确认的消息', { priority: 'final' });

      assert.equal(results[0]?.status, 'queued');
      assert.equal(outbox.listPending('user-a').some((item) => item.text === '必须保留直到确认的消息'), true);
      assert.equal(quota.snapshot('user-a').sentItems, 0);
    } finally {
      globalThis.fetch = originalFetch;
      const records = readFileSync(join(dir, 'delivery.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, any>);
      assert.equal(records[1]?.response?.errmsg, 'sendmessage response did not confirm delivery');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a new inbound drains an unconfirmed message with its original client_id', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    const clientIds: string[] = [];
    globalThis.fetch = async (_input, init) => {
      requestCount += 1;
      clientIds.push(JSON.parse(String(init?.body)).msg.client_id);
      return new Response(
        JSON.stringify(requestCount === 1 ? {} : { message_id: 2 }),
        { status: 200 },
      );
    };
    try {
      const first = await client.sendText('user-a', '等待新入站后续发', { priority: 'final' });
      assert.equal(first[0]?.status, 'queued');

      await (client as any).processMessage({
        message_id: 2,
        from_user_id: 'user-a',
        to_user_id: 'bot-user',
        client_id: 'inbound-client-2',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-b',
        item_list: [{ type: 1, text_item: { text: '0' } }],
      });

      assert.equal(requestCount, 2);
      assert.equal(clientIds[0], clientIds[1]);
      assert.deepEqual(outbox.list('user-a'), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('does not consume an inbound message when only an orphaned recovery notice remains', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    const notice = outbox.enqueueText({
      itemId: 'token-budget-notice:orphaned',
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'control',
      text: '请回复任意消息后继续',
    });
    assert.equal(notice.itemId, 'token-budget-notice:orphaned');

    let routedText: string | undefined;
    let recoveryContext: unknown;
    client.onMessage((_msg, text, _refText, _media, recovery) => {
      routedText = text;
      recoveryContext = recovery;
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ message_id: 123 }),
      { status: 200 },
    );
    try {
      await (client as any).processMessage({
        message_id: 2,
        from_user_id: 'user-a',
        to_user_id: 'bot-user',
        client_id: 'inbound-client-2',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-b',
        item_list: [{ type: 1, text_item: { text: '0' } }],
      });

      assert.equal(routedText, '0');
      assert.equal(recoveryContext, undefined);
      assert.deepEqual(outbox.listPending('user-a'), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('inbound diagnostics persist token and generation evidence without inbound text', async () => {
  await withStores(async (outbox, quota) => {
    const dir = mkdtempSync(join(tmpdir(), 'wxclient-inbound-diagnostics-'));
    const diagnostics = new DeliveryDiagnostics(join(dir, 'delivery.jsonl'));
    const client = new ILinkClient(credentials, { outbox, quota, diagnostics });

    try {
      await (client as any).processMessage({
        message_id: 'inbound-message-1',
        from_user_id: 'user-a',
        to_user_id: 'bot-user',
        client_id: 'inbound-client-1',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-a',
        item_list: [{ type: 1, text_item: { text: '入站正文不应落盘' } }],
      });

      const records = readFileSync(join(dir, 'delivery.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(records.length, 1);
      assert.equal(records[0]?.event, 'inbound');
      assert.equal(records[0]?.inboundMessageId, 'inbound-message-1');
      assert.equal(records[0]?.generation, 1);
      assert.equal(records[0]?.tokenVersion, 1);
      assert.equal(records[0]?.tokenChanged, true);
      assert.equal(records[0]?.itemCount, 1);
      assert.equal(JSON.stringify(records).includes('入站正文不应落盘'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('sendText acknowledges an HTTP success response that omits ret when message_id is present', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ message_id: 123 }),
      { status: 200 },
    );
    try {
      const results = await client.sendText('user-a', 'HTTP 成功但响应省略 ret');

      assert.equal(results[0]?.status, 'sent');
      assert.deepEqual(outbox.list('user-a'), []);
      assert.equal(quota.snapshot('user-a').sentItems, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('sendText drains every UTF-8 chunk after an HTTP success without ret', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ message_id: requestCount }), { status: 200 });
    };
    try {
      const results = await client.sendText('user-a', 'x'.repeat(4_501), { priority: 'final' });

      assert.equal(requestCount, 3);
      assert.equal(results.length, 3);
      assert.ok(results.every((result) => result.status === 'sent'));
      assert.deepEqual(outbox.list('user-a'), []);
      assert.equal(quota.snapshot('user-a').sentItems, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('protects the final queue with a visible recovery notice before the token budget is exhausted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxclient-recovery-notice-'));
  const outbox = new OutboxStore(join(dir, 'outbox.json'));
  const quota = new QuotaManager(join(dir, 'quota.json'), 'account-a', {
    maxItemsPerToken: 3,
    maxIntermediateItemsPerToken: 3,
    finalReserveItemsPerToken: 1,
  });
  const client = new ILinkClient(credentials, { outbox, quota });
  quota.recordInbound('user-a', 'message-1', 'context-a');
  (client as any).contextTokens.set('user-a', 'context-a');

  const originalFetch = globalThis.fetch;
  const payloads: Array<Record<string, any>> = [];
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  };
  try {
    await client.sendText('user-a', '第一块', { priority: 'final' });
    await client.sendText('user-a', '第二块', { priority: 'final' });
    await client.sendText('user-a', '第三块', { priority: 'final' });

    assert.equal(payloads.length, 3);
    assert.match(payloads[2].msg.item_list[0].text_item.text, /回复任意消息刷新 context_token/);
    assert.deepEqual(outbox.listPending('user-a').map((item) => item.text), ['第三块']);
    assert.equal(client.getDeliveryState('user-a').state, 'WAITING_INBOUND');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery notice reports the remaining durable backlog after an inbound drain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxclient-recovery-count-'));
  const outbox = new OutboxStore(join(dir, 'outbox.json'));
  const quota = new QuotaManager(join(dir, 'quota.json'), 'account-a', {
    maxItemsPerToken: 3,
    maxIntermediateItemsPerToken: 3,
    finalReserveItemsPerToken: 1,
  });
  const client = new ILinkClient(credentials, { outbox, quota });
  quota.recordInbound('user-a', 'message-1', 'context-a');
  (client as any).contextTokens.set('user-a', 'context-a');
  for (let i = 0; i < 5; i++) {
    outbox.enqueueText({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'intermediate',
      text: `积压中间块 ${i + 1}`,
    });
  }

  const originalFetch = globalThis.fetch;
  const payloads: Array<Record<string, any>> = [];
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ message_id: payloads.length }), { status: 200 });
  };
  try {
    await (client as any).processMessage({
      message_id: 2,
      from_user_id: 'user-a',
      to_user_id: 'bot-user',
      client_id: 'inbound-client-2',
      create_time_ms: Date.now(),
      message_type: 1,
      message_state: 0,
      context_token: 'context-b',
      item_list: [{ type: 1, text_item: { text: '0' } }],
    });

    const notice = payloads.find((payload) =>
      String(payload.msg.item_list[0].text_item.text).includes('回复任意消息'));
    assert.ok(notice, JSON.stringify(payloads));
    assert.match(String(notice.msg.item_list[0].text_item.text), /仍有 3 条积压消息/);
    assert.equal(outbox.listPending('user-a').length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
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

test('rate backoff keeps new intermediate text durable for the next inbound token', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ ret: -2, errcode: 17, errmsg: 'prepare failed' }), { status: 200 });
    };
    try {
      await client.sendText('user-a', '最终结果', { priority: 'final' });
      const result = await client.sendText('user-a', '冷却期内的中间文本', {
        streamType: 'intermediate',
        priority: 'intermediate',
      });

      assert.equal(result[0]?.status, 'rate-limited');
      assert.equal(requestCount, 1);
      assert.deepEqual(outbox.listPending('user-a').map((item) => item.priority), ['final', 'control', 'intermediate']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a fresh inbound token drains the final result and queued intermediate text', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    const payloads: Array<Record<string, any>> = [];
    let requestCount = 0;
    globalThis.fetch = async (_input, init) => {
      requestCount += 1;
      payloads.push(JSON.parse(String(init?.body)));
      if (requestCount === 1) {
        return new Response(JSON.stringify({ ret: -2, errcode: 17, errmsg: 'prepare failed' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    };
    try {
      await client.sendText('user-a', '最终结果', { priority: 'final' });
      const intermediate = await client.sendText('user-a', '之前被保护的中间消息', {
        streamType: 'intermediate',
        priority: 'intermediate',
      });

      assert.equal(intermediate[0]?.status, 'rate-limited');
      assert.equal(outbox.listPending('user-a').some((item) => item.text === '之前被保护的中间消息'), true);

      await (client as any).processMessage({
        message_id: 2,
        from_user_id: 'user-a',
        to_user_id: 'bot-user',
        client_id: 'inbound-client-2',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-b',
        item_list: [],
      });

      assert.equal(requestCount, 3);
      assert.deepEqual(
        payloads.slice(1).map((payload) => payload.msg.item_list[0].text_item.text),
        ['最终结果', '之前被保护的中间消息'],
      );
      assert.deepEqual(outbox.listPending('user-a'), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('local per-token budget warns at the tenth bubble without truncating a final batch', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    const payloads: Array<Record<string, any>> = [];
    globalThis.fetch = async (_input, init) => {
      requestCount += 1;
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ret: 0, errcode: 0, errmsg: '' }), { status: 200 });
    };
    try {
      for (let i = 0; i < 9; i++) {
        const results = await client.sendText('user-a', `中间块 ${i + 1}`, {
          streamType: 'intermediate',
          priority: 'intermediate',
        });
        if (i < 8) {
          assert.ok(results.length > 0 && results.every((result) => result.status === 'sent'));
        } else {
          assert.ok(results.length > 0 && results.every((result) => result.status === 'sent'));
        }
      }

      const final = await client.sendText('user-a', 'x'.repeat(4_501), { priority: 'final' });

      assert.ok(final.some((result) => result.status === 'queued'));
      assert.ok(payloads.some((payload) => payload.msg.item_list[0].text_item.text.includes('发送预算保护')));
      assert.equal(requestCount, 10);
      assert.equal(outbox.listPending('user-a').length, 3);
      assert.ok(outbox.listPending('user-a').every((item) => item.priority === 'final'));
      assert.equal(quota.snapshot('user-a').sentItems, 10);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a final result does not delete durable intermediate messages from the same generation', async () => {
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
      text: '需要在恢复后补发的中间文本',
    });

    await client.sendText('user-a', '最终结果', { priority: 'final' });

    const pending = outbox.listPending('user-a');
    assert.equal(pending.length, 2);
    assert.deepEqual(pending.map((item) => item.priority), ['final', 'intermediate']);
    assert.equal(pending.some((item) => item.text === '需要在恢复后补发的中间文本'), true);
  });
});

test('final chunks stay queued as a batch when the current token cannot fit them all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxclient-final-batch-'));
  const outbox = new OutboxStore(join(dir, 'outbox.json'));
  const quota = new QuotaManager(join(dir, 'quota.json'), 'account-a', {
    maxItemsPerToken: 4,
    maxIntermediateItemsPerToken: 4,
    finalReserveItemsPerToken: 1,
  });
  const client = new ILinkClient(credentials, { outbox, quota });
  quota.recordInbound('user-a', 'message-1', 'context-a');
  (client as any).contextTokens.set('user-a', 'context-a');

  const originalFetch = globalThis.fetch;
  const payloads: Array<Record<string, any>> = [];
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  };
  try {
    for (let i = 0; i < 2; i++) {
      await client.sendText('user-a', `中间块 ${i + 1}`, {
        streamType: 'intermediate',
        priority: 'intermediate',
      });
    }

    const results = await client.sendText('user-a', 'x'.repeat(4_501), { priority: 'final' });

    assert.ok(results.some((result) => result.status === 'queued'));
    assert.equal(payloads.length, 3);
    assert.ok(payloads[2].msg.item_list[0].text_item.text.includes('发送预算保护'));
    assert.equal(outbox.listPending('user-a').length, 3);
    assert.ok(outbox.listPending('user-a').every((item) => item.priority === 'final'));
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh inbound with the same context token gets one recovery attempt', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify(requestCount === 1
        ? { ret: -2, errcode: 17, errmsg: 'prepare failed' }
        : { ret: 0 }), { status: 200 });
    };
    try {
      await client.sendText('user-a', '等待恢复的最终结果', { priority: 'final' });

      await (client as any).processMessage({
        message_id: 2,
        from_user_id: 'user-a',
        to_user_id: 'bot-user',
        client_id: 'inbound-client-2',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-a',
        item_list: [{ type: 1, text_item: { text: '如何' } }],
      });

      assert.equal(requestCount, 2);
      assert.deepEqual(outbox.listPending('user-a'), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a new inbound drains a guarded final result when the token string is unchanged', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    const payloads: Array<Record<string, any>> = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ret: 0, message_id: payloads.length }), { status: 200 });
    };
    try {
      for (let i = 0; i < 9; i++) {
        const result = await client.sendText('user-a', `中间块 ${i + 1}`, {
          streamType: 'intermediate',
          priority: 'intermediate',
        });
        assert.ok(result.every((item) => item.status === 'sent'));
      }

      const guarded = await client.sendText('user-a', '需要恢复的最终结果', { priority: 'final' });
      assert.ok(guarded.some((item) => item.status === 'queued'));
      assert.equal(outbox.listPending('user-a').some((item) => item.text === '需要恢复的最终结果'), true);
      assert.equal(payloads.length, 10, 'nine intermediate chunks plus one recovery notice');

      await (client as any).processMessage({
        message_id: 2,
        from_user_id: 'user-a',
        to_user_id: 'bot-user',
        client_id: 'inbound-client-2',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-a',
        item_list: [],
      });

      assert.equal(payloads.at(-1)?.msg.item_list[0].text_item.text, '需要恢复的最终结果');
      assert.deepEqual(outbox.listPending('user-a'), []);
      const snapshot = quota.snapshot('user-a');
      assert.equal(snapshot.sentItems, 11, 'recovery keeps cumulative successful-send accounting');
      assert.equal(snapshot.tokenVersion, 1, 'recovery does not invent a token version');
      assert.equal(quota.getTokenBudget('user-a').sentItems, 1, 'only the resumed window counts locally');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('ret=-2 keeps intermediate backlog and the final result durable', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');
    outbox.enqueueText({
      accountId: 'account-a', userId: 'user-a', generation: 1, tokenVersion: 1,
      priority: 'intermediate', text: '过时的中间块',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ret: -2, errcode: 17, errmsg: 'prepare failed' }),
      { status: 200 },
    );
    try {
      await client.sendText('user-a', '最终结果', { priority: 'final' });

      const pending = outbox.listPending('user-a');
      assert.deepEqual(pending.map((item) => item.priority), ['final', 'control', 'intermediate']);
      assert.equal(pending.some((item) => item.text === '过时的中间块'), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('permanent send failures become terminal and are not retried automatically', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ ret: 5, errcode: 99, errmsg: 'permanent' }), { status: 200 });
    };
    try {
      const first = await client.sendText('user-a', '终态失败', { priority: 'final' });
      assert.equal(first[0]?.status, 'permanent-failure');
      assert.equal(outbox.list('user-a').find((item) => item.priority === 'final')?.state, 'permanent-failure');
      assert.equal(outbox.listPending('user-a').filter((item) => item.priority === 'control').length, 1);

      await client.resumePendingText('user-a');
      assert.equal(requestCount, 2, 'only the visible failure notice may be attempted');
      assert.equal(outbox.list('user-a').find((item) => item.priority === 'final')?.state, 'permanent-failure');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a permanent final failure leaves a durable visible failure notice', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      ret: 5,
      errcode: 99,
      errmsg: 'payload rejected',
    }), { status: 200 });
    try {
      const results = await client.sendText('user-a', '最终结果', { priority: 'final' });

      assert.equal(results[0]?.status, 'permanent-failure');
      assert.equal(outbox.list('user-a').find((item) => item.priority === 'final')?.state, 'permanent-failure');
      const notices = outbox.listPending('user-a').filter((item) => item.priority === 'control');
      assert.equal(notices.length, 1);
      assert.match(notices[0].text, /最终结果未送达/);
      assert.match(notices[0].text, /payload rejected/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a restarted client requeues legacy missing-ret send failures', async () => {
  await withStores(async (outbox, quota) => {
    const item = outbox.enqueueText({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'final',
      text: '恢复旧的最终结果',
    });
    outbox.markPermanentFailure(item.itemId, { errmsg: 'sendmessage response did not confirm ret=0' });
    const explicitFailure = outbox.enqueueText({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'control',
      text: '不要重试显式错误',
    });
    outbox.markPermanentFailure(explicitFailure.itemId, {
      ret: 5,
      errmsg: 'sendmessage response did not confirm ret=0',
    });

    new ILinkClient(credentials, { outbox, quota });

    assert.equal(outbox.get(item.itemId)?.state, 'pending');
    assert.equal(outbox.get(item.itemId)?.clientId, item.clientId);
    assert.equal(outbox.get(explicitFailure.itemId)?.state, 'permanent-failure');
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

test('sendImage rejects an over-budget file before uploading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wxmedia-budget-'));
  const imagePath = join(dir, 'large.png');
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  const dataDir = join(dir, 'state');
  const outbox = new OutboxStore(join(dataDir, 'outbox.json'));
  const quota = new QuotaManager(join(dataDir, 'quota.json'), 'account-a', {
    maxItems: 3,
    maxBytes: 4,
    finalReserveItems: 0,
    finalReserveBytes: 0,
  });
  const client = new ILinkClient(credentials, { outbox, quota });
  quota.recordInbound('user-a', 'message-1', 'context-a');
  (client as any).contextTokens.set('user-a', 'context-a');

  const originalFetch = globalThis.fetch;
  let uploadUrlRequests = 0;
  globalThis.fetch = async () => {
    uploadUrlRequests += 1;
    return new Response(JSON.stringify({ upload_param: 'must-not-be-requested' }), { status: 200 });
  };
  try {
    const results = await client.sendImage('user-a', imagePath);

    assert.equal(results[0]?.status, 'permanent-failure');
    assert.equal(uploadUrlRequests, 0);
    assert.equal(quota.snapshot('user-a').reservedItems, 0);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendImage preserves the task generation supplied by the caller', async () => {
  await withStores(async (_outbox, quota) => {
    const dir = mkdtempSync(join(tmpdir(), 'wxmedia-generation-'));
    const imagePath = join(dir, 'image.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    const client = new ILinkClient(credentials, {
      outbox: new OutboxStore(join(dir, 'outbox.json')),
      quota,
    });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    quota.recordInbound('user-a', 'message-2', 'context-b');
    (client as any).contextTokens.set('user-a', 'context-b');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/getuploadurl')) {
        return new Response(JSON.stringify({ upload_param: 'upload-param' }), { status: 200 });
      }
      if (url.includes('/c2c/upload')) {
        return new Response('', { status: 200, headers: { 'x-encrypted-param': 'download-param' } });
      }
      void init;
      return new Response(JSON.stringify({ ret: 0, errcode: 0, errmsg: '' }), { status: 200 });
    };
    try {
      const results = await client.sendImage('user-a', imagePath, undefined, {
        generation: 1,
        tokenVersion: 1,
      } as any);

      assert.equal(results[0]?.status, 'sent');
      assert.equal(results[0]?.generation, 1);
      assert.equal(results[0]?.tokenVersion, 1);
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
    const clientIds: string[] = [];
    globalThis.fetch = async (_input, init) => {
      requestCount += 1;
      clientIds.push(JSON.parse(String(init?.body)).msg.client_id);
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

      assert.equal(requestCount, 2);
      assert.equal(clientIds[0], clientIds[1], 'recovery must reuse the durable item client_id');
      assert.deepEqual(outbox.list('user-a'), []);
      assert.equal(client.getDeliveryState('user-a').state, 'READY');
      assert.equal(client.getDeliveryState('user-a').waitingForInbound, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('recovery drops orphan delivery notices instead of sending them after the final result', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');
    outbox.enqueueText({
      itemId: 'delivery-notice:missing-final',
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'control',
      text: '过时的恢复提示',
    });
    outbox.enqueueText({
      itemId: 'token-budget-notice:account-a:user-a:1',
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'control',
      text: '过时的预算提示',
    });
    outbox.enqueueText({
      itemId: 'final-result',
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'final',
      text: '完整最终结果',
    });

    const originalFetch = globalThis.fetch;
    const sent: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      sent.push(body.msg.item_list[0].text_item.text);
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    };
    try {
      await client.resumePendingText('user-a');

      assert.deepEqual(sent, ['完整最终结果']);
      assert.deepEqual(outbox.list('user-a'), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a restarted client resumes every queued final chunk once after a new token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-final-recovery-'));
  const outboxPath = join(dir, 'outbox.json');
  const quotaPath = join(dir, 'quota.json');
  const originalFetch = globalThis.fetch;
  try {
    const firstOutbox = new OutboxStore(outboxPath);
    const firstQuota = new QuotaManager(quotaPath, 'account-a');
    const first = new ILinkClient(credentials, { outbox: firstOutbox, quota: firstQuota });
    firstQuota.recordInbound('user-a', 'message-1', 'context-a');
    (first as any).contextTokens.set('user-a', 'context-a');

    globalThis.fetch = async () => new Response(JSON.stringify({
      ret: -2,
      errcode: 17,
      errmsg: 'prepare failed',
    }), { status: 200 });
    await first.sendText('user-a', 'x'.repeat(4_501), { priority: 'final' });

    const restarted = new ILinkClient(credentials, {
      outbox: new OutboxStore(outboxPath),
      quota: new QuotaManager(quotaPath, 'account-a'),
    });
    const restartedQuota = (restarted as any).quota as QuotaManager;
    restartedQuota.recordInbound('user-a', 'message-2', 'context-b');
    (restarted as any).contextTokens.set('user-a', 'context-b');

    const bodies: Array<Record<string, any>> = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    };

    await restarted.resumePendingText('user-a');
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies.map((body) => body.msg.item_list[0].text_item.text).join(''), 'x'.repeat(4_501));
    assert.equal(new Set(bodies.map((body) => body.msg.client_id)).size, 3);
    assert.deepEqual(new OutboxStore(outboxPath).list('user-a'), []);

    await restarted.resumePendingText('user-a');
    assert.equal(bodies.length, 3, 'a second drain must not duplicate acknowledged chunks');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a recovery inbound carries the pre-drain pending count to message handlers', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');
    outbox.enqueueText({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'final',
      text: '待恢复的最终结果',
    });

    let handlerArgs: unknown[] | undefined;
    client.onMessage((...args: unknown[]) => {
      handlerArgs = args;
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    try {
      await (client as any).processMessage({
        message_id: 2,
        from_user_id: 'user-a',
        to_user_id: 'bot-user',
        client_id: 'inbound-client-2',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-b',
        item_list: [{ type: 1, text_item: { text: '继续' } }],
      });

      assert.equal(handlerArgs?.[1], '继续');
      assert.deepEqual(handlerArgs?.[4], { pendingTextCount: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('any inbound with queued text carries a recovery snapshot before normal routing', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    (client as any).contextTokens.set('user-a', 'context-a');
    outbox.enqueueText({
      accountId: 'account-a',
      userId: 'user-a',
      generation: 1,
      tokenVersion: 1,
      priority: 'final',
      text: '待恢复的最终结果',
    });

    let handlerArgs: unknown[] | undefined;
    client.onMessage((...args: unknown[]) => {
      handlerArgs = args;
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    try {
      await (client as any).processMessage({
        message_id: 2,
        from_user_id: 'user-a',
        to_user_id: 'bot-user',
        client_id: 'inbound-client-2',
        create_time_ms: Date.now(),
        message_type: 1,
        message_state: 0,
        context_token: 'context-b',
        item_list: [{ type: 1 as const, text_item: { text: '如何' } }],
      });

      assert.equal(handlerArgs?.[1], '如何');
      assert.deepEqual(handlerArgs?.[4], { pendingTextCount: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a replayed inbound after restart does not replace the current context token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-replay-'));
  try {
    const outboxPath = join(dir, 'outbox.json');
    const quotaPath = join(dir, 'quota.json');
    const message = {
      message_id: 7,
      from_user_id: 'user-a',
      to_user_id: 'bot-user',
      client_id: 'inbound-client-7',
      create_time_ms: Date.now(),
      message_type: 1 as const,
      message_state: 0,
      context_token: 'old-token',
      item_list: [{ type: 1 as const, text_item: { text: '旧消息' } }],
    };

    const first = new ILinkClient(credentials, {
      outbox: new OutboxStore(outboxPath),
      quota: new QuotaManager(quotaPath, 'account-a'),
    });
    await (first as any).processMessage(message);

    const restarted = new ILinkClient(credentials, {
      outbox: new OutboxStore(outboxPath),
      quota: new QuotaManager(quotaPath, 'account-a'),
    });
    (restarted as any).contextTokens.set('user-a', 'current-token');
    let handlerCalls = 0;
    restarted.onMessage(() => {
      handlerCalls += 1;
    });

    await (restarted as any).processMessage(message);

    assert.equal(restarted.getContextToken('user-a'), 'current-token');
    assert.equal(handlerCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a final result keeps stale intermediate text durable for the same generation', async () => {
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
    assert.equal(pending.length, 2);
    assert.deepEqual(pending.map((item) => item.priority), ['final', 'intermediate']);
    assert.equal(pending[0].text, '最终结果');
    assert.equal(pending[1].text, '过时的中间文本');
  });
});

test('sendText preserves the task generation supplied by the caller', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    quota.recordInbound('user-a', 'message-2', 'context-b');
    (client as any).contextTokens.clear();

    await client.sendText('user-a', '旧任务最终结果', {
      priority: 'final',
      generation: 1,
      tokenVersion: 1,
    } as any);

    const pending = outbox.list('user-a');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].generation, 1);
    assert.equal(pending[0].tokenVersion, 1);
  });
});

test('queued final output keeps its task generation while using the current context token', async () => {
  await withStores(async (outbox, quota) => {
    const client = new ILinkClient(credentials, { outbox, quota });
    quota.recordInbound('user-a', 'message-1', 'context-a');
    quota.recordInbound('user-a', 'message-2', 'context-b');
    (client as any).contextTokens.set('user-a', 'context-b');

    const originalFetch = globalThis.fetch;
    let body: Record<string, any> | undefined;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ret: 0, errcode: 0, errmsg: '' }), { status: 200 });
    };
    try {
      const results = await client.sendText('user-a', '旧任务结果', {
        priority: 'final',
        generation: 1,
        tokenVersion: 1,
      });

      assert.equal(results[0]?.status, 'sent');
      assert.equal(results[0]?.generation, 1);
      assert.equal(body?.msg.context_token, 'context-b');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
