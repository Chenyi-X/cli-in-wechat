import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, type IntermediateMessage } from '../src/adapters/base.js';
import {
  mapPiEvent,
  PiAdapter,
  type PiEventLike,
  type PiMessageLike,
  type PiSessionLike,
  type PiSessionOptions,
} from '../src/adapters/pi-sdk.js';

// ─── mapPiEvent: pure event mapping (fixtures from real pi 0.84.2 runs) ──────

test('mapPiEvent maps tool_execution_start to a tool_use summary', () => {
  const ev: PiEventLike = {
    type: 'tool_execution_start',
    toolCallId: 'call_b92037cc1b27451fb485a5d4ab',
    toolName: 'bash',
    args: { command: 'echo pi-verify-ok; echo "exit_code=$?"' },
  };
  assert.deepEqual(mapPiEvent(ev), [
    {
      type: 'tool_use',
      content: '- Shell Command: `echo pi-verify-ok; echo "exit_code=$?"`',
      toolName: 'bash',
    },
  ]);
});

test('mapPiEvent maps tool_execution_end success and drops unsummarizable output', () => {
  // Raw bash output has no "Exit code N" marker, so summarizeToolResult returns
  // '' and nothing is emitted (no raw result spam).
  const raw: PiEventLike = {
    type: 'tool_execution_end',
    toolCallId: 'call_b92037cc1b27451fb485a5d4ab',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'pi-verify-ok\nexit_code=0\n' }] },
    isError: false,
  };
  assert.deepEqual(mapPiEvent(raw), []);

  // Output that summarizeToolResult understands is forwarded.
  const summarized: PiEventLike = {
    type: 'tool_execution_end',
    toolCallId: 'call_2',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'Exit code 2\nboom' }] },
    isError: false,
  };
  assert.deepEqual(mapPiEvent(summarized), [
    { type: 'tool_result', content: '  ↳ Exit: 2', toolName: 'bash' },
  ]);
});

test('mapPiEvent maps tool_execution_end errors', () => {
  const ev: PiEventLike = {
    type: 'tool_execution_end',
    toolCallId: 'call_3',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'x'.repeat(150) }] },
    isError: true,
  };
  assert.deepEqual(mapPiEvent(ev), [
    { type: 'tool_result', content: `  ↳ Error: ${'x'.repeat(100)}`, toolName: 'bash' },
  ]);
});

test('mapPiEvent falls back to the raw result for errors without content[] blocks', () => {
  // Error results may not carry the standard content[] shape; the raw result
  // must be stringified so "  ↳ Error: " never ends up empty.
  const stringResult: PiEventLike = {
    type: 'tool_execution_end',
    toolCallId: 'call_e1',
    toolName: 'bash',
    result: 'command not found',
    isError: true,
  };
  assert.deepEqual(mapPiEvent(stringResult), [
    { type: 'tool_result', content: '  ↳ Error: command not found', toolName: 'bash' },
  ]);

  const objectResult: PiEventLike = {
    type: 'tool_execution_end',
    toolCallId: 'call_e2',
    toolName: 'bash',
    result: { error: 'ENOENT: no such file' },
    isError: true,
  };
  assert.deepEqual(mapPiEvent(objectResult), [
    { type: 'tool_result', content: '  ↳ Error: {"error":"ENOENT: no such file"}', toolName: 'bash' },
  ]);
});

test('mapPiEvent maps assistant message_end text and thinking blocks', () => {
  const ev: PiEventLike = {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'The user wants me to count...', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: '1\n2' },
      ],
      stopReason: 'aborted',
      errorMessage: 'Request was aborted',
    },
  };
  assert.deepEqual(mapPiEvent(ev), [
    { type: 'thinking', content: 'The user wants me to count...' },
    { type: 'text', content: '1\n2' },
  ]);
});

test('mapPiEvent skips user message echoes', () => {
  const ev: PiEventLike = {
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text: '请用 bash 工具运行命令...' }] },
  };
  assert.deepEqual(mapPiEvent(ev), []);
});

test('mapPiEvent skips toolCall blocks in assistant messages (tool events carry them)', () => {
  const ev: PiEventLike = {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', toolCallId: 'call_b92', toolName: 'bash', arguments: { command: 'echo hi' } }],
      usage: { input: 4690, output: 22, cacheRead: 7488, cacheWrite: 0, totalTokens: 12200, cost: { total: 0.00860968 } },
    },
  };
  assert.deepEqual(mapPiEvent(ev), []);
});

test('mapPiEvent drops whitespace-only text blocks', () => {
  const ev: PiEventLike = {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: '  \n\t ' }] },
  };
  assert.deepEqual(mapPiEvent(ev), []);
});

test('mapPiEvent ignores delta and lifecycle events', () => {
  for (const type of [
    'message_update', 'message_start', 'turn_start', 'turn_end',
    'agent_start', 'agent_end', 'agent_settled', 'tool_execution_update', 'queue_update',
  ]) {
    assert.deepEqual(mapPiEvent({ type, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }), []);
  }
});

// ─── Fake session + adapter.execute() ────────────────────────────────────────

interface FakeSessionState {
  promptTexts: string[];
  abortCount: number;
  disposed: boolean;
  messages: PiMessageLike[];
  emit: (ev: PiEventLike) => void;
}

function createFakeSession(overrides: {
  sessionId?: string;
  events?: PiEventLike[];
  messages?: PiMessageLike[];
  /** Assistant messages appended to state.messages when prompt() runs —
   *  simulates the messages pi adds for the current turn. */
  appendOnPrompt?: PiMessageLike[];
  hangUntilAbort?: boolean;
  abortOnPrompt?: AbortController;
}): { session: PiSessionLike; state: FakeSessionState } {
  const listeners: Array<(ev: PiEventLike) => void> = [];
  let resolveAbort: () => void = () => { /* replaced below */ };
  const abortPromise = new Promise<void>((resolve) => { resolveAbort = resolve; });
  const state: FakeSessionState = {
    promptTexts: [],
    abortCount: 0,
    disposed: false,
    messages: overrides.messages ?? [],
    emit: (ev) => { for (const l of listeners) l(ev); },
  };
  const session: PiSessionLike = {
    sessionId: overrides.sessionId ?? 'pi-ses-1',
    subscribe: (l) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    prompt: async (text) => {
      state.promptTexts.push(text);
      for (const ev of overrides.events ?? []) state.emit(ev);
      for (const m of overrides.appendOnPrompt ?? []) state.messages.push(m);
      overrides.abortOnPrompt?.abort();
      if (overrides.hangUntilAbort) await abortPromise;
    },
    abort: async () => { state.abortCount++; resolveAbort(); },
    dispose: () => { state.disposed = true; },
    // Mimic AgentSession.getSessionStats(): cumulative totals over all messages
    // currently in state (assistant + any toolResult usage). The adapter diffs
    // this before/after a run, so simple runs yield exactly the summed usage of
    // the messages appended during that run.
    getSessionStats: () => {
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      let cost = 0;
      let user = 0;
      let assistant = 0;
      let toolCalls = 0;
      let toolResults = 0;
      for (const m of state.messages) {
        if (m.role === 'user') { user++; continue; }
        if (m.role === 'toolResult') { toolResults++; }
        else if (m.role === 'assistant') {
          assistant++;
          if (Array.isArray(m.content)) {
            toolCalls += m.content.filter((c) => c && (c as { type?: string }).type === 'toolCall').length;
          }
        }
        const u = m.usage;
        if (u) {
          tokens.input += u.input ?? 0;
          tokens.output += u.output ?? 0;
          tokens.cacheRead += u.cacheRead ?? 0;
          tokens.cacheWrite += u.cacheWrite ?? 0;
          cost += u.cost?.total ?? 0;
        }
      }
      tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
      return {
        sessionId: overrides.sessionId ?? 'pi-ses-1',
        userMessages: user,
        assistantMessages: assistant,
        toolCalls,
        toolResults,
        totalMessages: state.messages.length,
        tokens,
        cost,
      };
    },
    getContextUsage: () => undefined,
    agent: { state: { messages: state.messages } },
  };
  return { session, state };
}

function piSettings(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_SETTINGS,
    mode: 'auto' as const,
    effort: 'high',
    workDir: 'C:\\fixture-work',
    ...overrides,
  };
}

test('PiAdapter execute streams blocks and assembles result with usage', async () => {
  const turnMessages: PiMessageLike[] = [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', toolCallId: 'call_b92', toolName: 'bash', arguments: { command: 'echo hi' } }],
      usage: { input: 4690, output: 22, cacheRead: 7488, cacheWrite: 0, totalTokens: 12200, cost: { total: 0.00860968 } },
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'counting carefully' },
        { type: 'text', text: 'final answer' },
      ],
      usage: { input: 54, output: 51, cacheRead: 12160, cacheWrite: 0, totalTokens: 12265, cost: { total: 0.0034616 } },
    },
  ];
  const { session, state } = createFakeSession({
    // The assistant messages of this turn are appended while prompt() runs,
    // mirroring how pi extends state.messages during a run.
    appendOnPrompt: turnMessages,
    events: [
      { type: 'message_update', message: { role: 'assistant', content: [] } },
      { type: 'tool_execution_start', toolCallId: 'call_b92', toolName: 'bash', args: { command: 'echo hi' } },
      { type: 'tool_execution_end', toolCallId: 'call_b92', toolName: 'bash', result: { content: [{ type: 'text', text: 'hi\n' }] }, isError: false },
      { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'echo hi' }] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } },
    ],
  });

  const capturedOpts: PiSessionOptions[] = [];
  const activity: IntermediateMessage[] = [];
  const adapter = new PiAdapter({
    sessionFactory: async (opts) => { capturedOpts.push(opts); return session; },
  });

  const result = await adapter.execute('count to 2', {
    settings: piSettings({ systemPrompt: 'Be terse', sessionIds: { pi: 'old-ses' } }),
    onIntermediate: (msg) => activity.push(msg),
  });

  // Session factory got the mapped settings.
  assert.equal(capturedOpts.length, 1);
  assert.equal(capturedOpts[0].workDir, 'C:\\fixture-work');
  assert.equal(capturedOpts[0].sessionId, 'old-ses');
  assert.equal(capturedOpts[0].thinkingLevel, 'high');
  assert.deepEqual(capturedOpts[0].tools, ['read', 'bash', 'edit', 'write']);

  // systemPrompt is prefixed, not a systemPromptOverride.
  assert.equal(state.promptTexts[0], '[system instructions]\nBe terse\n\ncount to 2');

  // Block-level intermediates only (no delta, no user echo, no unsummarized result).
  assert.deepEqual(activity, [
    { type: 'tool_use', content: '- Shell Command: `echo hi`', toolName: 'bash' },
    { type: 'text', content: 'final answer' },
  ]);

  // Result assembled from the last assistant message; usage summed over all.
  assert.equal(result.text, 'final answer');
  assert.equal(result.thinking, 'counting carefully');
  assert.equal(result.sessionId, 'pi-ses-1');
  assert.equal(result.error, false);
  assert.ok(result.usage);
  assert.equal(result.usage.inputTokens, 4744);
  assert.equal(result.usage.outputTokens, 73);
  assert.equal(result.usage.cacheReadTokens, 19648);
  assert.equal(result.usage.cacheWriteTokens, 0);
  assert.ok(Math.abs(result.usage.totalCost - 0.01207128) < 1e-9);

  // close() disposes the cached session.
  adapter.close();
  assert.equal(state.disposed, true);
});

test('PiAdapter execute counts usage only for the current turn on a resumed session', async () => {
  // Resumed session: state.messages already carries the previous turn's
  // assistant message (with its usage) before this run's prompt.
  const messages: PiMessageLike[] = [
    { role: 'user', content: [{ type: 'text', text: 'previous question' }] },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'previous answer' }],
      usage: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 0, totalTokens: 1600, cost: { total: 0.01 } },
    },
  ];
  const { session } = createFakeSession({
    sessionId: 'pi-ses-resumed',
    messages,
    appendOnPrompt: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'new answer' }],
        usage: { input: 4690, output: 22, cacheRead: 7488, cacheWrite: 0, totalTokens: 12200, cost: { total: 0.00860968 } },
      },
    ],
  });
  const adapter = new PiAdapter({ sessionFactory: async () => session });

  const result = await adapter.execute('new question', { settings: piSettings() });

  // Text comes from the last assistant message (this turn), usage from this
  // turn only — the pre-existing history usage must NOT be re-counted.
  assert.equal(result.text, 'new answer');
  assert.ok(result.usage);
  assert.equal(result.usage.inputTokens, 4690);
  assert.equal(result.usage.outputTokens, 22);
  assert.equal(result.usage.cacheReadTokens, 7488);
  assert.equal(result.usage.cacheWriteTokens, 0);
  assert.ok(Math.abs(result.usage.totalCost - 0.00860968) < 1e-9);
});

test('PiAdapter execute disposes the previous session before replacing it', async () => {
  const first = createFakeSession({ sessionId: 'pi-ses-1' });
  const second = createFakeSession({ sessionId: 'pi-ses-2' });
  const sessions = [first.session, second.session];
  const adapter = new PiAdapter({ sessionFactory: async () => sessions.shift()! });

  await adapter.execute('first prompt', { settings: piSettings() });
  await adapter.execute('second prompt', { settings: piSettings() });

  // The first session was disposed when the second one replaced it; the
  // current (second) session is only disposed by close().
  assert.equal(first.state.disposed, true);
  assert.equal(second.state.disposed, false);
  adapter.close();
  assert.equal(second.state.disposed, true);
});

test('PiAdapter execute unsubscribes after prompt resolves so late events are dropped', async () => {
  const messages: PiMessageLike[] = [];
  const events: PiEventLike[] = [
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } },
  ];
  const { session, state } = createFakeSession({
    messages,
    events,
    appendOnPrompt: [{ role: 'assistant', content: [{ type: 'text', text: 'final answer' }] }],
  });
  const adapter = new PiAdapter({ sessionFactory: async () => session });

  const activity: IntermediateMessage[] = [];
  const result = await adapter.execute('hello', {
    settings: piSettings(),
    onIntermediate: (msg) => activity.push(msg),
  });
  assert.equal(result.text, 'final answer');
  assert.equal(activity.length, 1);

  // An event arriving after prompt() resolved must not reach the bridge
  // (the subscription was torn down in finally).
  state.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] } });
  assert.equal(activity.length, 1);
});

test('PiAdapter execute passes read-only tools in safe mode', async () => {
  const { session } = createFakeSession({});
  const capturedOpts: PiSessionOptions[] = [];
  const adapter = new PiAdapter({
    sessionFactory: async (opts) => { capturedOpts.push(opts); return session; },
  });

  await adapter.execute('safe prompt', { settings: piSettings({ mode: 'safe' }) });

  assert.deepEqual(capturedOpts[0].tools, ['read', 'grep', 'find', 'ls']);
});

test('PiAdapter execute in full mode delegates tools/excludeTools to pi settings', async () => {
  const { session } = createFakeSession({});
  const capturedOpts: PiSessionOptions[] = [];
  const adapter = new PiAdapter({
    sessionFactory: async (opts) => { capturedOpts.push(opts); return session; },
  });

  await adapter.execute('full prompt', { settings: piSettings({ mode: 'full' }) });

  // full passes no allowlist and no exclusions: the toolset comes entirely
  // from pi's own settings (defaultTools + extension/SDK custom tools).
  assert.equal(capturedOpts[0].tools, undefined);
  assert.equal(capturedOpts[0].excludeTools, undefined);
});

test('PiAdapter execute maps errorMessage to an error result', async () => {
  const { session } = createFakeSession({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'The user wants me to count...' }, { type: 'text', text: '1\n2' }],
        stopReason: 'aborted',
        errorMessage: 'Request was aborted',
      },
    ],
  });
  const adapter = new PiAdapter({ sessionFactory: async () => session });

  const result = await adapter.execute('count', { settings: piSettings() });

  assert.equal(result.text, 'Request was aborted');
  assert.equal(result.thinking, undefined);
  assert.equal(result.error, true);
});

test('PiAdapter execute returns 已取消 when the caller aborts', async () => {
  const controller = new AbortController();
  const { session, state } = createFakeSession({ abortOnPrompt: controller });

  const adapter = new PiAdapter({ sessionFactory: async () => session });
  const result = await adapter.execute('abort me', {
    settings: piSettings(),
    signal: controller.signal,
  });

  assert.deepEqual(result, { text: '已取消', error: true, duration: result.duration });
  assert.ok(typeof result.duration === 'number');
  // The abort was forwarded to the SDK session.
  assert.equal(state.abortCount, 1);
});

test('PiAdapter execute aborts the session on idle timeout', async () => {
  const { session, state } = createFakeSession({ hangUntilAbort: true });
  const adapter = new PiAdapter({ sessionFactory: async () => session });

  const result = await adapter.execute('hang', {
    settings: piSettings(),
    timeout: 50,
  });

  assert.equal(result.error, true);
  assert.match(result.text, /执行超时/);
  assert.equal(state.abortCount, 1);
});

// ─── isAvailable / listModels via injected sdkLoader ─────────────────────────

function fakeSdkLoader(models: Array<{ id: string; provider: string }>) {
  return async () => ({
    createAgentSession: async () => { throw new Error('not used'); },
    SessionManager: { create: () => ({}), open: () => ({}), list: async () => [] },
    ModelRuntime: { create: async () => ({ getModel: () => undefined, getAvailable: async () => models }) },
  });
}

test('PiAdapter isAvailable is false when the pi package is missing', async () => {
  const adapter = new PiAdapter({
    sdkLoader: async () => { throw new Error('Cannot find package'); },
  });
  assert.equal(await adapter.isAvailable(), false);
});

test('PiAdapter isAvailable is false when no models are available', async () => {
  const adapter = new PiAdapter({ sdkLoader: fakeSdkLoader([]) });
  assert.equal(await adapter.isAvailable(), false);
});

test('PiAdapter isAvailable is true when models are available', async () => {
  const adapter = new PiAdapter({
    sdkLoader: fakeSdkLoader([{ id: 'glm-5.3', provider: 'zai' }]),
  });
  assert.equal(await adapter.isAvailable(), true);
});

test('PiAdapter listModels returns provider/id strings', async () => {
  const adapter = new PiAdapter({
    sdkLoader: fakeSdkLoader([
      { id: 'claude-opus-4-5', provider: 'anthropic' },
      { id: 'glm-5.3', provider: 'zai' },
    ]),
  });
  assert.deepEqual(await adapter.listModels(), ['anthropic/claude-opus-4-5', 'zai/glm-5.3']);
});
