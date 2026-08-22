import { log } from '../utils/logger.js';
import { DEFAULT_CLI_TIMEOUT } from '../config.js';
import type {
  CLIAdapter,
  AdapterCapabilities,
  ExecOptions,
  ExecResult,
  ExecResultUsage,
  IntermediateMessage,
} from './base.js';
import { buildMediaPrompt, summarizeToolResult, summarizeToolUse } from './base.js';

// ─── Structural SDK types (no SDK import — keeps this module unit-testable) ──
// The pi package is an optional dependency and MUST NOT be statically imported
// at module top level: on machines without it, a static import would crash the
// whole bridge at startup. All SDK access goes through the dynamic import in
// defaultSdkLoader / the injected loader below.

export interface PiEventLike {
  type: string;
  [k: string]: unknown;
}

export interface PiMessageLike {
  role?: string;
  content?: Array<{ type?: string; text?: string; thinking?: string }> | unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  errorMessage?: string;
}

/** The subset of AgentSession this adapter consumes (fakes implement just this). */
export interface PiSessionLike {
  readonly sessionId: string;
  subscribe(listener: (ev: PiEventLike) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void> | void;
  dispose(): void;
  readonly agent: { readonly state: { readonly messages: readonly PiMessageLike[] } };
}

export interface PiSessionOptions {
  workDir: string;
  /** Session id (UUID) previously returned by pi, to resume; falsy = new session. */
  sessionId?: string;
  /** Raw model name from settings (bare id or `provider/id`); falsy = SDK default. */
  model?: string;
  /** pi thinking level ('off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'). */
  thinkingLevel?: string;
  /** Allowlist of tool names. */
  tools?: string[];
}

export type PiSessionFactory = (opts: PiSessionOptions) => Promise<PiSessionLike>;

export interface PiModelLike {
  id: string;
  provider: string;
}

export interface PiModelRuntimeLike {
  getModel(providerId: string, modelId: string): unknown;
  getAvailable(): Promise<readonly PiModelLike[]>;
}

export interface PiSdkModule {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: unknown }>;
  SessionManager: {
    create(cwd: string, ...args: unknown[]): unknown;
    open(path: string, ...args: unknown[]): unknown;
    list(cwd: string, ...args: unknown[]): Promise<Array<{ id: string; path: string }>>;
  };
  ModelRuntime: {
    create(...args: unknown[]): Promise<PiModelRuntimeLike>;
  };
}

export type PiSdkLoader = () => Promise<PiSdkModule>;

/** Default loader: dynamic import so machines without the pi package stay healthy. */
const defaultSdkLoader: PiSdkLoader = async () =>
  (await import('@earendil-works/pi-coding-agent')) as unknown as PiSdkModule;

const PI_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// ─── Pure event mapping (fixture-testable, no SDK dependency) ────────────────

/** Extract the concatenated text blocks out of a tool_execution_end result
 *  (`result.content: [{type:'text', text}]`). */
function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('');
}

/** Map one pi SDK event to 0..n intermediate messages. Pure: no SDK import,
 *  no side effects. Delta-class events (message_update etc.) yield nothing —
 *  WeChat only renders block-level output. */
export function mapPiEvent(ev: PiEventLike): IntermediateMessage[] {
  const messages: IntermediateMessage[] = [];

  if (ev.type === 'tool_execution_start') {
    const toolName = typeof ev.toolName === 'string' && ev.toolName ? ev.toolName : 'Tool';
    messages.push({
      type: 'tool_use',
      content: summarizeToolUse(toolName, ev.args),
      toolName,
    });
    return messages;
  }

  if (ev.type === 'tool_execution_end') {
    const toolName = typeof ev.toolName === 'string' && ev.toolName ? ev.toolName : 'Tool';
    const text = extractToolResultText(ev.result);
    if (ev.isError) {
      messages.push({
        type: 'tool_result',
        content: `  ↳ Error: ${text.substring(0, 100)}`,
        toolName,
      });
    } else {
      const summary = summarizeToolResult(toolName, text);
      if (summary) {
        messages.push({ type: 'tool_result', content: summary, toolName });
      }
    }
    return messages;
  }

  if (ev.type === 'message_end') {
    const message = ev.message as { role?: unknown; content?: unknown } | undefined;
    // Skip user-message echoes; only assistant output is forwarded.
    if (!message || message.role !== 'assistant') return messages;
    const content = message.content;
    if (!Array.isArray(content)) return messages;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: unknown; text?: unknown; thinking?: unknown };
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        messages.push({ type: 'text', content: b.text });
      } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        messages.push({ type: 'thinking', content: b.thinking });
      }
      // toolCall blocks are skipped on purpose: tool info already arrives via
      // tool_execution_start/end, emitting it here would duplicate every call.
    }
  }

  return messages;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export interface PiAdapterDeps {
  /** Injected for tests; defaults to dynamic import of the pi package. */
  sdkLoader?: PiSdkLoader;
  /** Injected for tests; defaults to the real createAgentSession flow. */
  sessionFactory?: PiSessionFactory;
}

export class PiAdapter implements CLIAdapter {
  readonly name = 'pi';
  readonly displayName = 'Pi';
  readonly command = 'pi';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe'], hasEffort: true, hasModel: true, hasSearch: false, hasBudget: false,
  };

  private readonly sdkLoader: PiSdkLoader;
  private readonly sessionFactory: PiSessionFactory;
  private modelRuntimePromise: Promise<PiModelRuntimeLike> | null = null;
  /** Latest live session, disposed by close() on shutdown. */
  private session: PiSessionLike | null = null;

  constructor(deps?: PiAdapterDeps) {
    this.sdkLoader = deps?.sdkLoader ?? defaultSdkLoader;
    this.sessionFactory = deps?.sessionFactory ?? ((opts) => this.createDefaultSession(opts));
  }

  async isAvailable(): Promise<boolean> {
    try {
      const runtime = await this.getModelRuntime();
      const available = await runtime.getAvailable();
      return available.length > 0;
    } catch {
      log.info('[pi] 未安装 pi');
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const runtime = await this.getModelRuntime();
    const available = await runtime.getAvailable();
    return available.map((m) => `${m.provider}/${m.id}`);
  }

  close(): void {
    try { this.session?.dispose(); } catch { /* ignore */ }
    this.session = null;
  }

  async execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const { settings, signal, onIntermediate } = opts;
    const workDir = settings.workDir || opts.workDir;
    const start = Date.now();
    const timeout = opts.timeout || DEFAULT_CLI_TIMEOUT;

    if (signal?.aborted) return { text: '已取消', error: true };

    let fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);
    if (settings.systemPrompt) {
      // Prefix form (not systemPromptOverride): keeps pi's default coding prompt.
      fullPrompt = `[system instructions]\n${settings.systemPrompt}\n\n${fullPrompt}`;
    }

    // mode: auto → default toolset; safe/plan → read-only tools (plan is not
    // declared in capabilities.modes, router treats it as safe).
    const tools = settings.mode === 'auto'
      ? ['read', 'bash', 'edit', 'write']
      : ['read', 'grep', 'find', 'ls'];
    const thinkingLevel = settings.effort && PI_THINKING_LEVELS.has(settings.effort)
      ? settings.effort
      : undefined;

    let session: PiSessionLike;
    try {
      session = await this.sessionFactory({
        workDir: workDir || process.cwd(),
        sessionId: settings.sessionIds[this.name],
        model: settings.model || undefined,
        thinkingLevel,
        tools,
      });
    } catch (err) {
      return {
        text: `pi 会话创建失败: ${(err as Error).message}`,
        error: true,
        duration: Date.now() - start,
      };
    }
    this.session = session;

    // Idle-timeout anti-wedge (mirrors claude.ts): the timer is re-armed on every
    // event, so a long-but-healthy run is never cut off, while a run that stops
    // producing output is aborted after `timeout` of silence.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const armIdleTimeout = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        void Promise.resolve(session.abort()).catch(() => { /* ignore */ });
      }, timeout);
    };

    const onAbort = () => {
      void Promise.resolve(session.abort()).catch(() => { /* ignore */ });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // Subscribe before prompt so no block-level event is missed.
      session.subscribe((ev) => {
        armIdleTimeout();
        if (signal?.aborted) return;
        for (const msg of mapPiEvent(ev)) onIntermediate?.(msg);
      });
      armIdleTimeout();

      log.debug(`[pi] prompt (model=${settings.model || 'default'} thinking=${thinkingLevel || 'default'} mode=${settings.mode} timeout=${timeout}ms)`);
      await session.prompt(fullPrompt);
    } catch (err) {
      if (signal?.aborted) return { text: '已取消', error: true, duration: Date.now() - start };
      if (timedOut) return this.timeoutResult(timeout, start);
      return {
        text: `pi 执行失败: ${(err as Error).message}`,
        error: true,
        duration: Date.now() - start,
      };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (signal?.aborted) return { text: '已取消', error: true, duration: Date.now() - start };
    if (timedOut) return this.timeoutResult(timeout, start);

    return this.assembleResult(session, start);
  }

  private timeoutResult(timeout: number, start: number): ExecResult {
    const mins = Math.round(timeout / 60000);
    log.warn(`[pi] 空闲超时 (${timeout}ms 无消息)，已中止`);
    return {
      text: `执行超时（${mins} 分钟无响应），已自动中止。`,
      error: true,
      duration: Date.now() - start,
    };
  }

  /** Build the ExecResult from the final agent state: last assistant message
   *  for text/thinking/error, all assistant messages for usage accumulation. */
  private assembleResult(session: PiSessionLike, start: number): ExecResult {
    const messages = Array.isArray(session.agent.state.messages) ? session.agent.state.messages : [];
    const assistantMessages = messages.filter((m) => m && m.role === 'assistant');
    const last = assistantMessages[assistantMessages.length - 1];

    let text = '';
    let thinking = '';
    let error = false;
    if (last) {
      if (typeof last.errorMessage === 'string' && last.errorMessage) {
        text = last.errorMessage;
        error = true;
      } else if (Array.isArray(last.content)) {
        for (const block of last.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') text += block.text;
          else if (block.type === 'thinking' && typeof block.thinking === 'string') thinking += block.thinking;
        }
      }
    }

    // Usage: sum across all assistant messages of this run (M8 hook, pi only).
    const usage: ExecResultUsage = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0,
    };
    let hasUsage = false;
    for (const m of assistantMessages) {
      const u = m.usage;
      if (!u || typeof u !== 'object') continue;
      hasUsage = true;
      usage.inputTokens += u.input ?? 0;
      usage.outputTokens += u.output ?? 0;
      usage.cacheReadTokens += u.cacheRead ?? 0;
      usage.cacheWriteTokens += u.cacheWrite ?? 0;
      usage.totalCost += u.cost?.total ?? 0;
    }

    return {
      text: text || '(无输出)',
      thinking: thinking || undefined,
      sessionId: session.sessionId,
      duration: Date.now() - start,
      error,
      usage: hasUsage ? usage : undefined,
    };
  }

  private getModelRuntime(): Promise<PiModelRuntimeLike> {
    if (!this.modelRuntimePromise) {
      this.modelRuntimePromise = (async () => {
        const pi = await this.sdkLoader();
        return await pi.ModelRuntime.create();
      })();
      // Do not poison the cache with a failed startup.
      this.modelRuntimePromise.catch(() => { this.modelRuntimePromise = null; });
    }
    return this.modelRuntimePromise;
  }

  /** Resolve a settings model name to a pi Model object. `provider/id` is looked
   *  up directly; a bare id matches on exact id or a unique `provider/id` suffix.
   *  Returns undefined when unresolvable (caller falls back to the SDK default). */
  private async resolveModel(modelName: string): Promise<unknown | undefined> {
    const raw = modelName.trim();
    if (!raw) return undefined;
    const runtime = await this.getModelRuntime();
    if (raw.includes('/')) {
      const slash = raw.indexOf('/');
      return runtime.getModel(raw.slice(0, slash), raw.slice(slash + 1));
    }
    const available = await runtime.getAvailable();
    const lower = raw.toLowerCase();
    const exact = available.find((m) => m.id.toLowerCase() === lower);
    if (exact) return exact;
    const suffix = `/${lower}`;
    const matches = available.filter((m) => `${m.provider}/${m.id}`.toLowerCase().endsWith(suffix));
    if (matches.length === 1) return matches[0];
    log.warn(`[pi] model not found: ${raw}, using default`);
    return undefined;
  }

  /** Production session factory: createAgentSession via dynamic import, with
   *  resume-by-id (SessionManager.list → open) falling back to a silent new session. */
  private async createDefaultSession(opts: PiSessionOptions): Promise<PiSessionLike> {
    const pi = await this.sdkLoader();

    let model: unknown;
    if (opts.model) model = await this.resolveModel(opts.model);

    let sessionManager: unknown;
    if (opts.sessionId) {
      try {
        const sessions = await pi.SessionManager.list(opts.workDir);
        const hit = sessions.find((s) => s.id === opts.sessionId);
        if (hit) {
          sessionManager = pi.SessionManager.open(hit.path);
        } else {
          log.info(`[pi] session ${opts.sessionId} not found, starting new session`);
        }
      } catch (err) {
        log.warn(`[pi] resume failed, starting new session: ${(err as Error).message}`);
      }
    }
    if (!sessionManager) sessionManager = pi.SessionManager.create(opts.workDir);

    const sessionOpts: Record<string, unknown> = {
      cwd: opts.workDir,
      sessionManager,
      // pi's built-in question tool needs interactive replies; phase 1 has none.
      excludeTools: ['ask_question'],
    };
    if (model) sessionOpts.model = model;
    if (opts.thinkingLevel) sessionOpts.thinkingLevel = opts.thinkingLevel;
    if (opts.tools) sessionOpts.tools = opts.tools;

    const { session } = await pi.createAgentSession(sessionOpts);
    return session as unknown as PiSessionLike;
  }
}
