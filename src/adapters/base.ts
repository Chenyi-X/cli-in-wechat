import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../utils/logger.js';
import type { DownloadedMedia } from '../utils/media.js';

export type ToolMode = 'auto' | 'safe' | 'plan';
export type MsgMode = 'verbose' | 'normal' | 'compact';

export interface UserSettings {
  // ── Universal ──
  defaultTool: string;
  mode: ToolMode;
  model: string;
  sessionIds: Record<string, string>;
  systemPrompt: string;
  workDir: string;

  // ── Claude Code ──
  effort: string;
  maxTurns: number;
  maxBudget: number;
  allowedTools: string;
  disallowedTools: string;
  verbose: boolean;
  bare: boolean;
  addDir: string;
  sessionName: string;

  // ── Codex ──
  sandbox: string;
  search: boolean;
  ephemeral: boolean;
  profile: string;

  // ── Kimi Code ──
  thinking: boolean;

  // ── Gemini ──
  approvalMode: string;
  includeDirs: string;
  extensions: string;

  // ── Output ──
  showThoughts: boolean;
  msgMode: MsgMode;
}

export const DEFAULT_SETTINGS: UserSettings = {
  defaultTool: '',
  mode: 'auto',
  model: '',
  sessionIds: {},
  systemPrompt: '',
  workDir: '',
  effort: 'high',
  maxTurns: 30,
  maxBudget: 0,
  allowedTools: '',
  disallowedTools: '',
  verbose: false,
  bare: false,
  addDir: '',
  sessionName: '',
  sandbox: '',
  search: false,
  ephemeral: false,
  profile: '',
  thinking: false,
  approvalMode: '',
  includeDirs: '',
  extensions: '',
  showThoughts: false,
  msgMode: 'normal',
};

export interface AskUserRequest {
  questions: Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

export interface ExecOptions {
  settings: UserSettings;
  workDir?: string;
  timeout?: number;
  extraArgs?: string[];
  signal?: AbortSignal;
  askUser?: (req: AskUserRequest) => Promise<Record<string, string>>;
  media?: DownloadedMedia[];
  /** Callback for streaming intermediate messages to WeChat */
  onIntermediate?: (msg: IntermediateMessage) => void;
}

export interface ExecResult {
  text: string;
  thinking?: string;
  sessionId?: string;
  cost?: number;
  duration?: number;
  error?: boolean;
  /** Set by the adapter when the error is positively identified as a session/resume failure. */
  sessionExpired?: boolean;
}

export interface IntermediateMessage {
  type: 'thinking' | 'text' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
}

export interface AdapterCapabilities {
  streaming: boolean;
  jsonOutput: boolean;
  sessionResume: boolean;
  modes: ToolMode[];
  hasEffort: boolean;
  hasModel: boolean;
  hasSearch: boolean;
  hasBudget: boolean;
}

export interface CLIAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly command: string;
  readonly capabilities: AdapterCapabilities;
  isAvailable(): Promise<boolean>;
  execute(prompt: string, opts: ExecOptions): Promise<ExecResult>;
}

// ─── Shared process helpers ────────────────────────────────
export const WIN = process.platform === 'win32';

/** On Windows, npm CLI wrappers (.cmd files) require shell:true to be executed by cmd.exe.
 *  This is the same mechanism npm scripts rely on and is the only reliable approach.
 *  Limitation: %VAR% patterns in user-supplied args may be expanded by cmd.exe. */
export function spawnProc(cmd: string, args: string[], opts: import('node:child_process').SpawnOptions): ChildProcess {
  log.debug(`[spawn] ${cmd} ${args.map(a => JSON.stringify(a)).join(' ')}`);
  if (!WIN) return spawn(cmd, args, opts);
  return spawn(cmd, args, { ...opts, shell: true });
}

export function commandExists(cmd: string): Promise<boolean> {
  const checker = WIN ? 'where' : 'which';
  return new Promise((resolve) => { const proc = spawn(checker, [cmd], { stdio: 'pipe' }); proc.on('close', (code) => resolve(code === 0)); proc.on('error', () => resolve(false)); });
}

export function setupAbort(proc: ChildProcess, signal?: AbortSignal): void {
  if (!signal) return; if (signal.aborted) { proc.kill('SIGTERM'); return; }
  const onAbort = () => proc.kill('SIGTERM'); signal.addEventListener('abort', onAbort, { once: true }); proc.on('close', () => signal.removeEventListener('abort', onAbort));
}

export function setupTimeout(proc: ChildProcess, timeout?: number): ReturnType<typeof setTimeout> | null {
  if (!timeout) return null; return setTimeout(() => proc.kill('SIGTERM'), timeout);
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '').replace(/\r/g, '');
}

/** Returns true only when text matches known session/resume failure patterns from CLI tools. */
export function isSessionError(text: string): boolean {
  return /session.*not.*(found|exist)|no.*(valid|previous).*session|invalid.*session|session.*(invalid|expired|not.*found)|cannot.*resume|resume.*(fail|not.*found)/i.test(text);
}

// ─── Shared tool summarization (used by Claude & OpenCode adapters) ───

export function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.substring(0, maxLen)}...` : text;
}

export function basenameFromPath(pathLike: string): string {
  const parts = pathLike.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : pathLike;
}

export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(asString).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const preferred = ['text', 'output', 'result', 'content', 'message'];
    for (const key of preferred) {
      if (key in obj) {
        const text = asString(obj[key]);
        if (text) return text;
      }
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function pickStringField(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (!(key in obj)) continue;
    const value = asString(obj[key]).trim();
    if (value) return value;
  }
  return '';
}

export function summarizeToolUse(toolName: string, input: unknown): string {
  const t = toolName || 'Tool';
  const obj = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};

  if (/^bash$/i.test(t)) {
    const cmd = pickStringField(obj, ['command', 'cmd', 'script']);
    return cmd
      ? `- Shell Command: \`${truncate(cmd.replace(/\s+/g, ' ').trim(), 120)}\``
      : '- Shell Command';
  }

  if (/^read$/i.test(t)) {
    const path = pickStringField(obj, ['file_path', 'path', 'filePath']);
    return path
      ? `- Read File: \`${basenameFromPath(path)}\``
      : '- Read File';
  }

  if (/^skill$/i.test(t)) {
    const skill = pickStringField(obj, ['skill', 'name', 'skillName']);
    return skill
      ? `- Skill: \`${basenameFromPath(skill)}\``
      : '- Skill';
  }

  if (/^glob$/i.test(t)) {
    const pattern = pickStringField(obj, ['pattern', 'glob']);
    return pattern
      ? `- Glob: \`${truncate(pattern, 80)}\``
      : '- Glob';
  }

  if (/^grep$/i.test(t)) {
    const pattern = pickStringField(obj, ['pattern', 'query', 'regex']);
    return pattern
      ? `- Grep: \`${truncate(pattern, 80)}\``
      : '- Grep';
  }

  if (/^ls$/i.test(t)) {
    const path = pickStringField(obj, ['path', 'directory']);
    return path
      ? `- LS: \`${truncate(path, 80)}\``
      : '- LS';
  }

  if (/^edit$/i.test(t)) {
    const path = pickStringField(obj, ['file_path', 'path', 'filePath']);
    return path
      ? `- Edit File: \`${basenameFromPath(path)}\``
      : '- Edit File';
  }

  if (/^write$/i.test(t)) {
    const path = pickStringField(obj, ['file_path', 'path', 'filePath']);
    return path
      ? `- Write File: \`${basenameFromPath(path)}\``
      : '- Write File';
  }

  if (/^multiedit$/i.test(t)) {
    const path = pickStringField(obj, ['file_path', 'path', 'filePath']);
    return path
      ? `- MultiEdit: \`${basenameFromPath(path)}\``
      : '- MultiEdit';
  }

  if (/^notebookread$/i.test(t)) {
    const path = pickStringField(obj, ['notebook_path', 'path', 'file_path']);
    return path
      ? `- NotebookRead: \`${basenameFromPath(path)}\``
      : '- NotebookRead';
  }

  if (/^notebookedit$/i.test(t)) {
    const path = pickStringField(obj, ['notebook_path', 'path', 'file_path']);
    return path
      ? `- NotebookEdit: \`${basenameFromPath(path)}\``
      : '- NotebookEdit';
  }

  if (/^webfetch$/i.test(t)) {
    const url = pickStringField(obj, ['url', 'uri']);
    return url
      ? `- WebFetch: \`${truncate(url, 120)}\``
      : '- WebFetch';
  }

  if (/^websearch$/i.test(t)) {
    const query = pickStringField(obj, ['query', 'q', 'searchQuery']);
    return query
      ? `- WebSearch: \`${truncate(query, 100)}\``
      : '- WebSearch';
  }

  if (/^(task|agent)$/i.test(t)) {
    const sub = pickStringField(obj, ['agent', 'agent_type', 'subagent_type', 'name']);
    const prompt = pickStringField(obj, ['description', 'prompt', 'task', 'instruction']);
    if (sub && prompt) return `- ${t}: \`${sub}\` — ${truncate(prompt, 80)}`;
    if (sub) return `- ${t}: \`${sub}\``;
    if (prompt) return `- ${t}: ${truncate(prompt, 80)}`;
    return `- ${t}`;
  }

  if (/^todowrite$/i.test(t)) {
    return '- TodoWrite';
  }

  return `- ${t}`;
}

export function summarizeToolResult(toolName: string | undefined, content: unknown): string {
  const text = asString(content).replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const tool = (toolName || '').toLowerCase();
  if (tool === 'bash') {
    const exit = text.match(/Exit code\s+(-?\d+)/i);
    if (exit) return `  ↳ Exit: ${exit[1]}`;
    if (/\bno output\b/i.test(text)) return '  ↳ Exit: no output';
    return '';
  }

  if (tool === 'skill') {
    const m = text.match(/Launching skill:\s*([^\s]+)/i);
    if (m) return `  ↳ Launch: \`${m[1]}\``;
    return '';
  }

  if (tool === 'webfetch') {
    const status = text.match(/\b(?:HTTP|Status)\s*[: ]\s*(\d{3})/i);
    if (status) return `  ↳ HTTP: ${status[1]}`;
    return '';
  }

  if (tool === 'websearch') {
    const n = text.match(/(\d+)\s+(?:result|results|条)/i);
    if (n) return `  ↳ Results: ${n[1]}`;
    return '';
  }

  if (tool === 'agent' || tool === 'task') {
    if (/completed with no output/i.test(text)) return '  ↳ Completed';
    if (/error/i.test(text)) return '  ↳ Error';
    return '';
  }

  if (tool === 'read') {
    return '';
  }

  return '';
}
