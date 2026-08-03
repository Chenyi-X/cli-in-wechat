import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Router } from '../src/bridge/router.js';
import { DEFAULT_SETTINGS } from '../src/adapters/base.js';
import type { BridgeConfig } from '../src/config.js';
import type { WeixinMessage } from '../src/ilink/types.js';

function createRouter() {
  const messages: Array<{ uid: string; text: string }> = [];
  const starts: string[] = [];
  const delivery = { waitingForInbound: false, pendingTextCount: 0 };
  const resumed: string[] = [];

  const ilink = {
    sendText: async (uid: string, text: string) => {
      messages.push({ uid, text });
    },
    startTyping: async (uid: string) => {
      starts.push(uid);
      return () => {};
    },
    getDeliveryState: () => delivery,
    resumePendingText: async (uid: string) => {
      resumed.push(uid);
      return [];
    },
    onMessage: () => {},
  };

  const registry = {
    isAvailable: (name: string) => ['claude', 'codex', 'gemini'].includes(name),
    getNameByDisplayName: (displayName: string) => ({ Claude: 'claude', Codex: 'codex', Gemini: 'gemini' }[displayName]),
    getAvailableNames: () => ['claude', 'codex', 'gemini'],
    get: (name: string) => ({
      name,
      displayName: name === 'claude' ? 'Claude' : name === 'codex' ? 'Codex' : 'Gemini',
      capabilities: { sessionResume: false },
    }),
  };

  const state = new Map<string, { defaultTool?: string; sessionIds: Record<string, string> }>();
  const sessions = {
    get: (uid: string) => {
      if (!state.has(uid)) state.set(uid, { defaultTool: '', sessionIds: {} });
      return state.get(uid)!;
    },
    update: (uid: string, partial: { defaultTool?: string }) => Object.assign(sessions.get(uid), partial),
    setSession: () => {},
    clearSession: () => {},
  };

  const config: BridgeConfig = {
    defaultTool: 'gemini',
    maxResponseChunkSize: 2000,
    cliTimeout: 300_000,
    typingInterval: 5000,
    allowedUsers: [],
    workDir: process.cwd(),
    tools: {},
  };

  const router = new Router(ilink as any, registry as any, sessions as any, config);
  return { router: router as any, messages, starts, sessions, delivery, resumed };
}

function makeMessage(uid: string): WeixinMessage {
  return {
    message_id: 1,
    from_user_id: uid,
    to_user_id: 'bot',
    client_id: 'client',
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 0,
    context_token: 'ctx',
    item_list: [],
  };
}

test('default settings allow up to 100 turns', () => {
  assert.equal(DEFAULT_SETTINGS.maxTurns, 100);
});

test('/reset restores the independent 100-turn default', async () => {
  const { router, sessions } = createRouter();

  await router.handleSlash('u1', '/reset');

  assert.equal((sessions.get('u1') as any).maxTurns, 100);
});

test('getCli prefers @tool in text over quoted footer tool', () => {
  const { router, sessions } = createRouter();
  sessions.update('u1', { defaultTool: 'gemini' });

  const tool = router.getCli('u1', '@codex explain this', 'something\n— Claude | 1.2s');

  assert.equal(tool, 'codex');
});

test('getCli fallback to refText if no @tool mention', () => {
  const { router, sessions } = createRouter();
  sessions.update('u1', { defaultTool: 'gemini' });

  const tool = router.getCli('u1', 'explain this', 'something\n— Claude | 1.2s');

  assert.equal(tool, 'claude');
});

test('pending question resolution follows getCli-selected tool', async () => {
  const { router, sessions } = createRouter();
  sessions.update('u1', { defaultTool: 'gemini' });

  let resolvedAnswer = '';
  router.pendingQuestions.set('u1:codex', {
    resolve: (answer: string) => {
      resolvedAnswer = answer;
    },
    timeout: setTimeout(() => {}, 1000),
    toolName: 'codex',
  });

  let execCalled = false;
  router.exec = async () => {
    execCalled = true;
  };

  await router.handle(makeMessage('u1'), '@codex 2', 'question body\n— Claude | 等待回复');

  assert.equal(resolvedAnswer, '@codex 2');
  assert.equal(execCalled, false);
  assert.equal(router.pendingQuestions.has('u1:codex'), false);
});

test('handle() rejects unknown @tool mention', async () => {
  const { router, messages } = createRouter();

  await router.handle(makeMessage('u1'), '@unknown hello', '');

  assert.ok(messages[0].text.includes('未知终端: @unknown'));
});

test('handle() combines prompt and refText with double newline', async () => {
  const { router } = createRouter();
  let capturedPrompt = '';
  router.exec = async (uid: string, tool: string, prompt: string) => {
    capturedPrompt = prompt;
  };

  await router.handle(makeMessage('u1'), 'explain', 'source code');

  assert.equal(capturedPrompt, 'explain\n\nsource code');
});

test('handle() omits refText in combined prompt if refText is empty', async () => {
  const { router } = createRouter();
  let capturedPrompt = '';
  router.exec = async (uid: string, tool: string, prompt: string) => {
    capturedPrompt = prompt;
  };

  await router.handle(makeMessage('u1'), 'explain', '');

  assert.equal(capturedPrompt, 'explain');
});

test('plain 继续 is intercepted only for waiting durable text', async () => {
  const { router, delivery, resumed } = createRouter();
  delivery.waitingForInbound = true;
  delivery.pendingTextCount = 1;
  let execCalled = false;
  router.exec = async () => {
    execCalled = true;
  };

  await router.handle(makeMessage('u1'), '继续', '');

  assert.deepEqual(resumed, ['u1']);
  assert.equal(execCalled, false);
});

test('plain 继续 reaches the Agent when no durable delivery is waiting', async () => {
  const { router } = createRouter();
  let capturedPrompt = '';
  router.exec = async (uid: string, tool: string, prompt: string) => {
    capturedPrompt = prompt;
  };

  await router.handle(makeMessage('u1'), '继续', '');

  assert.equal(capturedPrompt, '继续');
});

test('plain 继续 uses the inbound recovery snapshot after automatic drain', async () => {
  const { router, resumed } = createRouter();
  let execCalled = false;
  router.exec = async () => {
    execCalled = true;
  };

  await router.handle(makeMessage('u1'), '继续', '', undefined, { pendingTextCount: 1 });

  assert.deepEqual(resumed, ['u1']);
  assert.equal(execCalled, false);
});

test('exec sends the complete final body when intermediate delivery was not confirmed', async () => {
  const { router } = createRouter();
  const sent: Array<{ text: string; options?: Record<string, unknown> }> = [];
  (router as any).ilink.sendText = async (_uid: string, text: string, options?: Record<string, unknown>) => {
    sent.push({ text, options });
    return options?.streamType === 'intermediate'
      ? [{ status: 'rate-limited' }]
      : [{ status: 'sent' }];
  };
  (router as any).registry = {
    get: () => ({
      displayName: 'Gemini',
      capabilities: { sessionResume: false },
      execute: async (_prompt: string, options: any) => {
        options.onIntermediate?.({ type: 'text', content: 'partial text' });
        return { text: 'complete final body', duration: 1, error: false };
      },
    }),
  };

  await (router as any).exec('u1', 'gemini', 'prompt');

  const final = sent.find((message) => message.options?.priority === 'final');
  assert.ok(final?.text.includes('complete final body'), JSON.stringify(sent));
});

test('normal mode includes Activity, tool name, and duration after confirmed streaming', async () => {
  const { router } = createRouter();
  const sent: Array<{ text: string; options?: Record<string, unknown> }> = [];
  (router as any).ilink.sendText = async (_uid: string, text: string, options?: Record<string, unknown>) => {
    sent.push({ text, options });
    return [{ status: 'sent' }];
  };
  (router as any).registry = {
    get: () => ({
      displayName: 'Claude',
      capabilities: { sessionResume: false },
      execute: async (_prompt: string, options: any) => {
        options.onIntermediate?.({
          type: 'tool_use',
          content: '- Shell Command: Get-ChildItem',
          toolName: 'Shell Command',
        });
        options.onIntermediate?.({ type: 'text', content: 'partial text' });
        return { text: 'complete final body', duration: 1_234, error: false };
      },
    }),
  };

  await (router as any).exec('u1', 'claude', 'prompt');

  const final = sent.find((message) => message.options?.priority === 'final');
  assert.ok(final?.text.includes('Activity'), JSON.stringify(sent));
  assert.ok(final?.text.includes('Shell Command'), JSON.stringify(sent));
  assert.ok(final?.text.includes('Claude | 1.2s'), JSON.stringify(sent));
});

test('normal mode includes Activity in the final result when Activity delivery is suppressed', async () => {
  const { router } = createRouter();
  const sent: Array<{ text: string; options?: Record<string, unknown> }> = [];
  (router as any).ilink.sendText = async (_uid: string, text: string, options?: Record<string, unknown>) => {
    sent.push({ text, options });
    return options?.priority === 'activity' ? [{ status: 'rate-limited' }] : [{ status: 'sent' }];
  };
  (router as any).sendNormalActivityBatches = async () => ({
    split: true,
    unsentLines: ['- Shell Command: Get-ChildItem'],
  });
  (router as any).registry = {
    get: () => ({
      displayName: 'Claude',
      capabilities: { sessionResume: false },
      execute: async (_prompt: string, options: any) => {
        options.onIntermediate?.({ type: 'tool_use', content: '- Shell Command: Get-ChildItem', toolName: 'Shell Command' });
        return { text: '完整结果', duration: 2_000, error: false };
      },
    }),
  };

  await (router as any).exec('u1', 'claude', 'prompt');

  const final = sent.find((message) => message.options?.priority === 'final');
  assert.ok(final?.text.includes('完整结果'), JSON.stringify(sent));
  assert.ok(final?.text.includes('Activity'), JSON.stringify(sent));
});

test('chain final output keeps the delivery context captured at task start', async () => {
  const { router } = createRouter();
  const sent: Array<{ text: string; options?: Record<string, unknown> }> = [];
  (router as any).ilink.getDeliveryContext = () => ({ generation: 4, tokenVersion: 2 });
  (router as any).ilink.sendText = async (_uid: string, text: string, options?: Record<string, unknown>) => {
    sent.push({ text, options });
    return [{ status: 'sent' }];
  };
  const adapter = {
    displayName: 'Tool',
    capabilities: { sessionResume: false },
    execute: async () => ({ text: 'chain output', duration: 1, error: false }),
  };
  (router as any).registry = { get: () => adapter };

  await (router as any).chain('u1', 'gemini', 'codex', 'prompt');

  const final = sent.find((message) => message.options?.priority === 'final');
  assert.equal(final?.options?.generation, 4);
  assert.equal(final?.options?.tokenVersion, 2);
});

test('exec failure keeps the delivery context captured at task start', async () => {
  const { router } = createRouter();
  const sent: Array<{ text: string; options?: Record<string, unknown> }> = [];
  (router as any).ilink.getDeliveryContext = () => ({ generation: 4, tokenVersion: 2 });
  (router as any).ilink.sendText = async (_uid: string, text: string, options?: Record<string, unknown>) => {
    sent.push({ text, options });
    return [{ status: 'sent' }];
  };
  (router as any).registry = {
    get: () => ({
      displayName: 'Gemini',
      capabilities: { sessionResume: false },
      execute: async () => {
        throw new Error('adapter failed');
      },
    }),
  };

  await (router as any).exec('u1', 'gemini', 'prompt');

  assert.equal(sent[0]?.options?.priority, 'final');
  assert.equal(sent[0]?.options?.generation, 4);
  assert.equal(sent[0]?.options?.tokenVersion, 2);
});

test('exec captures delivery context before asynchronous typing setup', async () => {
  const { router } = createRouter();
  const sent: Array<{ text: string; options?: Record<string, unknown> }> = [];
  let context = { generation: 1, tokenVersion: 1 };
  (router as any).ilink.getDeliveryContext = () => context;
  (router as any).ilink.startTyping = async () => {
    context = { generation: 2, tokenVersion: 2 };
    return () => {};
  };
  (router as any).ilink.sendText = async (_uid: string, text: string, options?: Record<string, unknown>) => {
    sent.push({ text, options });
    return [{ status: 'sent' }];
  };
  (router as any).registry = {
    get: () => ({
      displayName: 'Gemini',
      capabilities: { sessionResume: false },
      execute: async () => ({ text: 'result', duration: 1, error: false }),
    }),
  };

  await (router as any).exec('u1', 'gemini', 'prompt');

  const final = sent.find((message) => message.options?.priority === 'final');
  assert.equal(final?.options?.generation, 1);
  assert.equal(final?.options?.tokenVersion, 1);
});

test('parseAndSendFiles reports unexpected media exceptions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-router-media-'));
  const filePath = join(dir, 'image.png');
  writeFileSync(filePath, 'image');
  try {
    const { router } = createRouter();
    (router as any).ilink.sendImage = async () => {
      throw new Error('upload broke');
    };

    const result = await (router as any).parseAndSendFiles('u1', `[SEND_FILE: ${filePath}]`);

    assert.match(result.failedFiles[0], /upload broke/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleSlash /model strips accidental /. suffix from model name', async () => {
  const { router, sessions, messages } = createRouter();

  await router.handleSlash('u1', '/model glm-5/.');

  assert.equal((sessions.get('u1') as any).model, 'glm-5');
  assert.equal(messages[messages.length - 1]?.text, 'model → glm-5');
});

test('handleSlash /model 默认 resets model only', async () => {
  const { router, sessions, messages } = createRouter();
  sessions.update('u1', { model: 'glm-5', effort: 'low', mode: 'safe' } as any);

  await router.handleSlash('u1', '/model 默认');

  const settings = sessions.get('u1') as any;
  assert.equal(settings.model, '');
  assert.equal(settings.effort, 'low');
  assert.equal(settings.mode, 'safe');
  assert.equal(messages[messages.length - 1]?.text, 'model → 默认');
});

test('splitNormalActivityLines keeps single batch when within boundary', () => {
  const { router } = createRouter();
  const lines = [
    '- Skill: directory-list',
    '- Shell Command: dir "C:\\tmp\\demo"',
    '- Shell Command: ls -la',
  ];

  const batches = (router as any).splitNormalActivityLines(lines);

  assert.equal(Array.isArray(batches), true);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], lines);
});

test('splitNormalActivityLines splits oversized activity into multiple batches', () => {
  const { router } = createRouter();
  const lines = Array.from({ length: 18 }, (_, i) => `- Shell Command: very long command ${i + 1} ${'x'.repeat(80)}`);

  const batches = (router as any).splitNormalActivityLines(lines);

  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), lines);
  for (const batch of batches) {
    assert.ok(batch.length > 0);
  }
});

test('sendNormalActivityBatches waits 5 seconds between oversized batches', async () => {
  const { router, messages } = createRouter();
  const lines = Array.from({ length: 20 }, (_, i) => `- Shell Command: item ${i + 1} ${'y'.repeat(90)}`);
  const delays: number[] = [];
  (router as any).sleep = async (ms: number) => {
    delays.push(ms);
  };
  (router as any).ilink.sendText = async (_uid: string, text: string) => {
    messages.push({ uid: _uid, text });
    return [{ status: 'sent' }];
  };

  await (router as any).sendNormalActivityBatches('u1', lines);

  const activityMessages = messages.filter((m) => m.text.startsWith('Activity'));
  assert.ok(activityMessages.length > 1);
  assert.deepEqual(delays, Array(activityMessages.length - 1).fill(5000));
});

test('exec sanitizes stale malformed model before adapter execution', async () => {
  const { router, sessions } = createRouter();
  const capturedModels: string[] = [];

  (router as any).registry.get = (_name: string) => ({
    name: 'opencode',
    displayName: 'OpenCode',
    capabilities: { sessionResume: false },
    execute: async (_prompt: string, opts: any) => {
      capturedModels.push(opts.settings.model);
      return { text: 'ok', error: false };
    },
  });

  sessions.update('u1', { model: 'glm-5/.' } as any);
  await router.exec('u1', 'opencode', 'hello');

  assert.equal(capturedModels[0], 'glm-5');
  assert.equal((sessions.get('u1') as any).model, 'glm-5');
});

test('exec maps stale default-alias model to empty before adapter execution', async () => {
  const { router, sessions } = createRouter();
  const capturedModels: string[] = [];

  (router as any).registry.get = (_name: string) => ({
    name: 'opencode',
    displayName: 'OpenCode',
    capabilities: { sessionResume: false },
    execute: async (_prompt: string, opts: any) => {
      capturedModels.push(opts.settings.model);
      return { text: 'ok', error: false };
    },
  });

  sessions.update('u1', { model: '默认/.' } as any);
  await router.exec('u1', 'opencode', 'hello');

  assert.equal(capturedModels[0], '');
  assert.equal((sessions.get('u1') as any).model, '');
});

// ─── Boolean-toggle confirmations must match the stored value (regression) ───
// Bug: update() mutates the live settings ref, so reading settings.<flag> after update()
// reported the inverted state. These assert the reply text matches what was actually stored.

for (const { cmd, field, on } of [
  { cmd: 'verbose', field: 'verbose', on: 'ON' },
  { cmd: 'search', field: 'search', on: 'ON' },
  { cmd: 'ephemeral', field: 'ephemeral', on: 'ON' },
  { cmd: 'thinking', field: 'thinking', on: 'ON (深度思考)' },
  { cmd: 'bare', field: 'bare', on: 'ON (跳过配置加载)' },
]) {
  test(`/${cmd} toggle reports the value it actually stored (on then off)`, async () => {
    const { router, sessions, messages } = createRouter();

    await router.handleSlash('u1', `/${cmd}`);
    assert.equal((sessions.get('u1') as any)[field], true, `${field} stored true`);
    assert.ok(messages[messages.length - 1].text.includes(on), `reply says ${on}`);

    await router.handleSlash('u1', `/${cmd}`);
    assert.equal((sessions.get('u1') as any)[field], false, `${field} stored false`);
    assert.ok(messages[messages.length - 1].text.includes('OFF'), 'reply says OFF');
  });
}
