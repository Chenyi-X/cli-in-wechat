import { log } from '../utils/logger.js';
import type { CLIAdapter, ExecOptions, ExecResult, AdapterCapabilities, IntermediateMessage } from './base.js';
import { commandExists, spawnProc, setupAbort, setupTimeout, stripAnsi, summarizeToolUse, summarizeToolResult } from './base.js';
import type { DownloadedMedia } from '../utils/media.js';
import { copyMediaToWorkDir } from '../utils/media.js';
import { execSync } from 'node:child_process';
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import type { Part, ToolPart, ToolState, Event, GlobalEvent } from '@opencode-ai/sdk';

const modelResolveCache = new Map<string, string>();

export function resolveBareModelFromList(model: string, availableModels: string[]): string {
  const raw = model.trim().replace(/\/+$/, '');
  if (!raw || raw.includes('/')) return raw;

  const suffix = `/${raw.toLowerCase()}`;
  const matches = availableModels
    .map((item) => item.trim())
    .filter((item) => item.includes('/'))
    .filter((item) => item.toLowerCase().endsWith(suffix));

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return raw;

  const preferred = matches.find((item) => /baiduqianfancodingplan/i.test(item));
  return preferred || raw;
}

function buildMediaPrompt(prompt: string, media?: DownloadedMedia[], workDir?: string): string {
  if (!media || media.length === 0) return prompt;
  
  const copiedMedia = workDir ? media.map(m => copyMediaToWorkDir(m, workDir)) : media;
  
  const fileList = copiedMedia.map(m => {
    const relativePath = workDir && m.path.startsWith(workDir) 
      ? m.path.slice(workDir.length).replace(/^[\/\\]/, '')
      : m.path;
    const typeNames: Record<string, string> = { image: '图片', file: '文件', video: '视频' };
    const sizeStr = m.size ? `${(m.size / 1024).toFixed(1)}KB` : '未知大小';
    return `- ${m.fileName}\n  类型: ${typeNames[m.type] || '文件'}\n  大小: ${sizeStr}\n  路径: ${relativePath}`;
  }).join('\n\n');
  
  const userPrompt = prompt.trim() && !prompt.startsWith('[文件:') && !prompt.startsWith('[图片:') && !prompt.startsWith('[视频:')
    ? `\n\n用户说：${prompt}`
    : '';
  
  return `已接收到用户通过微信发送的文件：

${fileList}

文件已保存到工作目录。请勿主动读取或处理这些文件，等待用户明确指示需要做什么。${userPrompt}`;
}

/** Parse a tool state into IntermediateMessage events */
function emitToolStateEvents(
  toolName: string,
  state: ToolState,
  onIntermediate?: (msg: IntermediateMessage) => void,
): void {
  if (!onIntermediate) return;

  switch (state.status) {
    case 'pending':
    case 'running':
      onIntermediate({
        type: 'tool_use',
        content: summarizeToolUse(toolName, state.input),
        toolName,
      });
      break;
    case 'completed':
      if (state.output) {
        const summary = summarizeToolResult(toolName, state.output);
        if (summary) {
          onIntermediate({
            type: 'tool_result',
            content: summary,
            toolName,
          });
        }
      }
      break;
    case 'error':
      onIntermediate({
        type: 'tool_result',
        content: `  ↳ Error: ${(state.error || '').substring(0, 100)}`,
        toolName,
      });
      break;
  }
}

/** Extract result text and thinking from session parts */
function extractResultFromParts(parts: Part[]): { text: string; thinking: string } {
  let text = '';
  let thinking = '';
  for (const part of parts) {
    if (part.type === 'text') {
      text += (part as any).text || '';
    } else if (part.type === 'reasoning') {
      thinking += (part as any).text || '';
    }
  }
  return { text, thinking };
}

/** Shared SDK client — lazily started, reused across calls */
let sharedClient: import('@opencode-ai/sdk').OpencodeClient | null = null;
let sharedServerClose: (() => void) | null = null;

async function getOrCreateClient(): Promise<import('@opencode-ai/sdk').OpencodeClient> {
  if (sharedClient) return sharedClient;

  try {
    const { client, server } = await createOpencode();
    sharedClient = client;
    sharedServerClose = () => server.close();
    log.info('[opencode/sdk] server started');
    return client;
  } catch (err) {
    log.warn(`[opencode/sdk] createOpencode failed: ${(err as Error).message}, trying client-only mode`);
    // Fallback: try connecting to existing server
    try {
      sharedClient = createOpencodeClient({ baseUrl: 'http://localhost:4096' });
      return sharedClient;
    } catch {
      throw new Error(`无法启动 OpenCode SDK: ${(err as Error).message}`);
    }
  }
}

export class OpenCodeAdapter implements CLIAdapter {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';
  readonly command = 'opencode';
  readonly capabilities: AdapterCapabilities = {
    streaming: true, jsonOutput: true, sessionResume: true,
    modes: ['auto', 'safe', 'plan'], hasEffort: false, hasModel: true, hasSearch: false, hasBudget: false,
  };

  async isAvailable(): Promise<boolean> { return commandExists(this.command); }

private resolveModelArg(model: string, workDir?: string): string {
    const raw = model.trim().replace(/\/+$/, '');
    if (!raw || raw.includes('/')) return raw;

    const key = raw.toLowerCase();
    const cached = modelResolveCache.get(key);
    if (cached) return cached;

    try {
      const output = execSync('opencode models', {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const availableModels = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const resolved = resolveBareModelFromList(raw, availableModels);
      if (resolved !== raw) {
        modelResolveCache.set(key, resolved);
        log.debug(`[opencode] model alias resolved: ${raw} -> ${resolved}`);
        return resolved;
      }
      log.warn(`[opencode] model not found in available models: ${raw}, tried: ${availableModels.slice(0, 10).join(', ')}`);
      return raw;
    } catch (err) {
      log.warn(`[opencode] models command failed: ${(err as Error).message}`);
      return raw;
    }
  }

  async execute(prompt: string, opts: ExecOptions): Promise<ExecResult> {
    const { settings, onIntermediate, signal } = opts;
    const workDir = settings.workDir || opts.workDir;
    const fullPrompt = buildMediaPrompt(prompt, opts.media, workDir);

    // Determine model
    let providerID = '';
    let modelID = '';
    if (settings.model) {
      const resolvedModel = this.resolveModelArg(settings.model, workDir);
      const parts = resolvedModel.split('/');
      if (parts.length === 2) {
        providerID = parts[0];
        modelID = parts[1];
      }
    }

    const client = await getOrCreateClient();

    // Create session
    const session = await client.session.create({
      body: workDir ? { title: 'cli-in-wechat' } : undefined,
    });
    // @ts-ignore
    const sessionId = session.data?.id || session.id;
    if (!sessionId) {
      throw new Error('Failed to create OpenCode session');
    }

    log.debug(`[opencode/sdk] session created: ${sessionId}`);

    // Restore previous session if resume is enabled
    const prevSid = settings.sessionIds[this.name];
    if (prevSid && prevSid !== sessionId) {
      // OpenCode SDK doesn't have a direct "resume" API like CLI --resume flag.
      // We just use the newly created session.
    }

    // Subscribe to SSE events
    const seenToolCallIds = new Set<string>();
    let resultText = '';
    let resultThinking = '';
    let resultError = false;
    let finished = false;

    const msgMode = settings.msgMode || 'normal';
    const streamIntermediate = msgMode !== 'compact' && onIntermediate;

    const ssePromise = client.event.subscribe({
      onSseEvent: (event) => {
        if (finished) return;
        const payload = event.data as GlobalEvent;
        if (!payload || !payload.payload) return;

        // Only process events for our session
        const ev = payload.payload as Event;
        const evSessionId = (ev as any).properties?.sessionID
          || (ev as any).properties?.info?.sessionID
          || (ev as any).properties?.part?.sessionID;

        if (evSessionId && evSessionId !== sessionId) return;

        switch (ev.type) {
          case 'message.part.updated': {
            const part = (ev as any).properties?.part as Part | undefined;
            if (!part) return;

            if (part.type === 'text') {
              const textPart = part as any;
              resultText += textPart.text || '';
              if (streamIntermediate && textPart.text?.trim()) {
                onIntermediate!({ type: 'text', content: textPart.text });
              }
            } else if (part.type === 'reasoning') {
              const reasoningPart = part as any;
              resultThinking += reasoningPart.text || '';
              if (streamIntermediate && reasoningPart.text?.trim()) {
                onIntermediate!({ type: 'thinking', content: reasoningPart.text });
              }
            } else if (part.type === 'tool') {
              const toolPart = part as ToolPart;
              const toolName = toolPart.tool || 'Tool';
              const callId = toolPart.callID || '';

              // Only emit events once per callID state transition
              const key = `${callId}:${toolPart.state.status}`;
              if (seenToolCallIds.has(key)) return;
              seenToolCallIds.add(key);

              emitToolStateEvents(toolName, toolPart.state, streamIntermediate ? onIntermediate : undefined);
            }
            break;
          }

          case 'session.idle':
            finished = true;
            break;

          case 'session.error': {
            const error = (ev as any).properties?.error;
            if (error) {
              resultError = true;
              if (error.message) {
                resultText += `\n[Error: ${error.message}]`;
              }
            }
            finished = true;
            break;
          }

          case 'session.status': {
            const status = (ev as any).properties?.status;
            if (status?.type === 'idle') {
              finished = true;
            }
            break;
          }
        }
      },
    });

    // Start SSE listener (runs in background)
    ssePromise.catch((err) => {
      log.error(`[opencode/sdk] SSE error: ${(err as Error).message}`);
    });

    // Small delay to ensure SSE listener is active before sending prompt
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Build model config
    const modelConfig: Record<string, unknown> = {};
    if (providerID && modelID) {
      modelConfig.model = { providerID, modelID };
    }

    // Build permission mode
    let permissionMode = 'default';
    if (settings.mode === 'auto') {
      permissionMode = 'bypassPermissions';
    } else if (settings.mode === 'plan') {
      permissionMode = 'plan';
    }

    // Set workdir config if needed
    if (workDir) {
      try {
        await client.config.update({
          body: {
            // @ts-ignore
            $schema: undefined,
          },
        });
      } catch {
        // ignore config update errors
      }
    }

    // Send prompt async (non-blocking)
    try {
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: fullPrompt }],
          ...modelConfig,
          ...(permissionMode !== 'default' ? { permissionMode } : {}),
        } as any,
      });
      log.debug(`[opencode/sdk] prompt sent async`);
    } catch (err) {
      log.error(`[opencode/sdk] promptAsync failed: ${(err as Error).message}`);
      resultError = true;
      resultText = `发送提示失败: ${(err as Error).message}`;
      finished = true;
    }

    // Wait for completion (poll session status or use timeout)
    const start = Date.now();
    const timeout = opts.timeout || 300_000;

    while (!finished && (Date.now() - start) < timeout) {
      if (signal?.aborted) {
        try {
          await client.session.abort({ path: { id: sessionId } });
        } catch { /* ignore */ }
        return { text: '已取消', error: true };
      }

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Check session status
      try {
        const statusResult = await client.session.status();
        // @ts-ignore
        const statuses = statusResult.data || statusResult;
        const sessionStatus = (statuses as any)?.[sessionId];
        if (sessionStatus?.type === 'idle') {
          finished = true;
        }
      } catch {
        // ignore status errors
      }
    }

    if (Date.now() - start >= timeout && !finished) {
      try {
        await client.session.abort({ path: { id: sessionId } });
      } catch { /* ignore */ }
      resultText += '\n[超时]';
      resultError = true;
    }

    // Fetch final result from session messages
    try {
      const messagesResult = await client.session.messages({
        path: { id: sessionId },
        query: { limit: 1 },
      });
      // @ts-ignore
      const messages = messagesResult.data || messagesResult;
      if (Array.isArray(messages) && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        const parts = lastMsg?.parts || [];
        const extracted = extractResultFromParts(parts);
        if (extracted.text && !resultText) resultText = extracted.text;
        if (extracted.thinking && !resultThinking) resultThinking = extracted.thinking;
      }
    } catch (err) {
      log.debug(`[opencode/sdk] failed to fetch messages: ${(err as Error).message}`);
    }

    // Clean up session
    try {
      await client.session.delete({ path: { id: sessionId } });
    } catch {
      // ignore cleanup errors
    }

    return {
      text: resultText || '(无输出)',
      thinking: resultThinking || undefined,
      sessionId,
      duration: Date.now() - start,
      error: resultError,
    };
  }
}
