import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { generateWechatUin, encryptAesEcb, aesEcbPaddedSize, encodeMessageAesKey, md5 } from '../utils/crypto.js';
import { log } from '../utils/logger.js';
import { fetchWithRetry, describeNetworkError, isRetryableNetworkError } from '../utils/http.js';
import { DATA_DIR, accountStatePath, savePollCursor, loadPollCursor, saveContextTokens, loadContextTokens } from '../config.js';
import { downloadImage, downloadFile, downloadVideo, type DownloadedMedia } from '../utils/media.js';
import { OutboxStore, type OutboxPriority, type OutboxTextItem } from './outbox.js';
import { QuotaManager, type QuotaReservation } from './quota.js';
import { chunkUtf8Text } from './text-chunk.js';
import { classifyApiFailure, ILinkApiError, type ApiErrorDetails, type SendResult } from './send-result.js';
import { DeliveryDiagnostics, type DeliveryDiagnosticInput } from './diagnostics.js';
import type {
  Credentials,
  WeixinMessage,
  GetUpdatesResponse,
  MessageItem,
  GetConfigResponse,
  SendMessageResponse,
} from './types.js';

const CHANNEL_VERSION = '1.0.2';
const HTTP_TIMEOUT_MS = 45_000;
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const BASE_RATE_LIMIT_COOLDOWN_MS = 150_000; // ~2.5 minutes
const MAX_RATE_LIMIT_COOLDOWN_MS = 420_000; // ~7 minutes
const UNCONFIRMED_SEND_RESPONSE = 'sendmessage response did not confirm delivery';
const LEGACY_MISSING_RET_ERROR = 'sendmessage response did not confirm ret=0';
const RECOVERY_NOTICE_TEXT = (pendingCount: number): string =>
  `发送预算保护：已达到当前 context_token 的安全发送边界，本轮仍有 ${pendingCount} 条积压消息，请回复任意消息刷新 context_token，系统会自动续发。`;

// Upload media types
const UPLOAD_MEDIA_TYPE_IMAGE = 1;
const UPLOAD_MEDIA_TYPE_VIDEO = 2;
const UPLOAD_MEDIA_TYPE_FILE = 3;

type SendStreamType = 'regular' | 'intermediate';

export type DeliveryState =
  | 'READY'
  | 'SENDING'
  | 'WAITING_INBOUND'
  | 'RATE_BACKOFF'
  | 'PERMANENT_FAILURE';

export interface DeliveryContext {
  generation: number;
  tokenVersion: number;
}

export interface InboundRecoveryContext {
  pendingTextCount: number;
}

interface UserRateLimitState {
  consecutiveRet2: number;
  suppressIntermediateUntil: number;
  blockAllSendsUntil: number;
}

interface DeliveryTraceContext {
  itemId?: string;
  itemSequence?: number;
  bubbleSequence?: number;
  generation?: number;
  tokenVersion?: number;
  priority?: string;
}

export interface ILinkClientOptions {
  outbox?: OutboxStore;
  quota?: QuotaManager;
  accountId?: string;
  diagnostics?: DeliveryDiagnostics;
}

export type MessageHandler = (
  msg: WeixinMessage,
  text: string,
  refText: string,
  media?: DownloadedMedia[],
  recovery?: InboundRecoveryContext,
) => void;

export class ILinkClient {
  private credentials: Credentials;
  private pollCursor: string;
  private running = false;
  private contextTokens: Map<string, string>;
  private typingTickets = new Map<string, { ticket: string; ts: number }>();
  private handlers: MessageHandler[] = [];
  private sendQueues = new Map<string, Promise<unknown>>();
  private rateLimitStates = new Map<string, UserRateLimitState>();
  private waitingForInbound = new Set<string>();
  private deliveryStates = new Map<string, DeliveryState>();
  private readonly accountId: string;
  private readonly outbox: OutboxStore;
  private readonly quota: QuotaManager;
  private readonly diagnostics?: DeliveryDiagnostics;
  private readonly startupRecoveryUsers = new Set<string>();
  private backoffMs = 1000;
  private abortController: AbortController | null = null;
  private consecutiveFailures = 0;
  private longPollTimeoutMs = HTTP_TIMEOUT_MS;
  private reloginInFlight = false;
  private onReloginNeeded?: () => Promise<Credentials | null>;
  // Bounded de-dup of messages: the long-poll cursor can re-deliver a message
  // (at-least-once), and re-running a CLI command twice is harmful. Keyed per-user
  // (from_user_id:message_id) so we never collide across conversations.
  private seenMsgIds = new Set<string>();
  private seenMsgOrder: string[] = [];

  constructor(credentials: Credentials, options: ILinkClientOptions = {}) {
    this.credentials = credentials;
    this.accountId = options.accountId || credentials.ilinkBotId;
    this.pollCursor = loadPollCursor(this.accountId);
    this.contextTokens = loadContextTokens(this.accountId);
    this.outbox = options.outbox || new OutboxStore(join(DATA_DIR, 'outbox.json'));
    this.quota = options.quota || new QuotaManager(join(DATA_DIR, 'quota.json'), this.accountId);
    this.diagnostics = options.diagnostics
      || (!options.outbox && !options.quota
        ? new DeliveryDiagnostics(accountStatePath(this.accountId, 'delivery-diagnostics.jsonl'))
        : undefined);
    const recovered = this.outbox.requeuePermanentFailures((item) =>
      item.accountId === this.accountId
      && item.terminalError?.ret === undefined
      && item.terminalError?.errcode === undefined
      && (item.terminalError?.errmsg === UNCONFIRMED_SEND_RESPONSE
        || item.terminalError?.errmsg === LEGACY_MISSING_RET_ERROR));
    if (recovered > 0) {
      log.warn(`[send] 已恢复 ${recovered} 个旧版误判的未确认发送项，将使用原 client_id 续发`);
    }
    const localBudgetRecoveryCandidates = this.outbox.list().filter((item) => {
      if (item.accountId !== this.accountId || !this.isLocalBudgetFailure(item)) return false;
      const snapshot = this.quota.snapshot(item.userId);
      if (snapshot.inboundGeneration <= item.generation) return false;
      this.startupRecoveryUsers.add(item.userId);
      return true;
    });
    const recoveredLocalBudget = this.outbox.requeuePermanentFailures((item) =>
      localBudgetRecoveryCandidates.some((candidate) => candidate.itemId === item.itemId));
    if (recoveredLocalBudget > 0) {
      log.warn(`[send] 重启恢复 ${recoveredLocalBudget} 个已在新入站后被旧进程误标失败的本地预算项`);
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /** Optional self-heal: invoked when the session expires (errcode -14/-13). Should
   *  re-run the QR login, persist the new credentials, and return them — the poll loop
   *  then swaps them in and continues instead of killing the whole process. */
  setReloginHandler(handler: () => Promise<Credentials | null>): void {
    this.onReloginNeeded = handler;
  }

  updateCredentials(credentials: Credentials): void {
    this.credentials = credentials;
  }

  /** First-seen check for a (user, message) pair; records it (bounded) and returns false
   *  on replay. Composite-keyed so two users never collide on the same numeric id. */
  private isFreshMessage(userId: string, id: number): boolean {
    const key = `${userId}:${id}`;
    if (this.seenMsgIds.has(key)) return false;
    this.seenMsgIds.add(key);
    this.seenMsgOrder.push(key);
    if (this.seenMsgOrder.length > 1000) {
      const evict = this.seenMsgOrder.shift();
      if (evict !== undefined) this.seenMsgIds.delete(evict);
    }
    return true;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${this.credentials.botToken}`,
      'X-WECHAT-UIN': generateWechatUin(),
    };
  }

  private baseInfo() {
    return { channel_version: CHANNEL_VERSION };
  }

  // ─── Lifecycle ─────────────────────────────────────────

  start(): void {
    this.running = true;
    log.info('iLink 消息轮询已启动');
    void this.drainStartupRecovery();
    this.pollLoop();
  }

  private async drainStartupRecovery(): Promise<void> {
    for (const userId of this.startupRecoveryUsers) {
      if (!this.contextTokens.get(userId)) {
        log.warn(`[send] 重启恢复等待 context_token: ${userId.substring(0, 12)}...`);
        continue;
      }
      try {
        const results = await this.drainOutbox(userId);
        const sent = results.filter((result) => result.status === 'sent').length;
        log.info(`[send] 重启恢复完成: ${userId.substring(0, 12)}... sent=${sent} pending=${this.outbox.listPending(userId, this.accountId).length}`);
      } catch (err) {
        log.error(`[send] 重启恢复失败: ${userId.substring(0, 12)}...`, err);
      }
    }
    this.startupRecoveryUsers.clear();
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    log.info('iLink 消息轮询已停止');
  }

  // ─── Long-polling loop ─────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const msgs = await this.getUpdates();
        this.backoffMs = 1000;
        this.consecutiveFailures = 0;

        for (const msg of msgs) {
          await this.processMessage(msg);
        }
      } catch (err: unknown) {
        if (!this.running) return;

        const error = err as { name?: string; errcode?: number; message?: string };

        if (error.name === 'AbortError') {
          continue; // normal long-poll timeout, not a failure
        }

        if (error.errcode === -14 || error.errcode === -13) {
          if (await this.handleSessionExpired()) continue;
          // Keep running either way (never silently kill the process), but give advice that
          // matches reality: only point at manual re-login when there is no relogin handler.
          if (!this.onReloginNeeded) {
            log.error('会话已过期。请删除 ~/.wx-ai-bridge/credentials.json 后重启以重新登录。');
          } else {
            log.warn('自动重新登录未成功，将在稍后重试…');
          }
          await sleep(30_000);
          continue;
        }

        this.consecutiveFailures += 1;
        // Surface a loud, actionable diagnostic once the loop has been failing for a while
        // (issue #18 class): a steady stream of generic '轮询错误' hides the real cause.
        if (this.consecutiveFailures === 5 || this.consecutiveFailures % 20 === 0) {
          if (isRetryableNetworkError(err)) {
            log.error(`轮询持续失败 ${this.consecutiveFailures} 次:`);
            log.error(describeNetworkError(err));
          } else {
            log.error(`轮询持续失败 ${this.consecutiveFailures} 次:`, error.message || err);
          }
        } else {
          log.error('轮询错误:', error.message || err);
        }

        // Exponential backoff with full jitter, capped at 30s.
        const jittered = Math.floor(this.backoffMs * (0.5 + Math.random() * 0.5));
        await sleep(jittered);
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      }
    }
  }

  /** Drive the optional relogin handler exactly once at a time. Returns true if the
   *  session was refreshed (caller should continue the loop). */
  private async handleSessionExpired(): Promise<boolean> {
    if (!this.onReloginNeeded || this.reloginInFlight) return false;
    this.reloginInFlight = true;
    try {
      log.warn('会话已过期，正在尝试重新登录…');
      const creds = await this.onReloginNeeded();
      if (creds) {
        this.credentials = creds;
        this.consecutiveFailures = 0;
        this.backoffMs = 1000;
        log.info('重新登录成功，继续运行');
        return true;
      }
      return false;
    } catch (err) {
      log.error('自动重新登录失败:', (err as Error).message);
      return false;
    } finally {
      this.reloginInFlight = false;
    }
  }

  private async getUpdates(): Promise<WeixinMessage[]> {
    // Keep the manual long-poll deadline: when it fires it aborts the controller, which
    // fetchWithRetry surfaces as an AbortError (NOT retried) so pollLoop treats it as a
    // normal long-poll timeout. Genuine transient drops (ECONNRESET) within the window
    // are retried by fetchWithRetry. The per-attempt timeout is a backstop set above the
    // manual deadline so the manual abort always wins the race.
    this.abortController = new AbortController();
    const timer = setTimeout(() => this.abortController?.abort(), this.longPollTimeoutMs);

    try {
      const res = await fetchWithRetry(
        `${this.credentials.baseUrl}/ilink/bot/getupdates`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            get_updates_buf: this.pollCursor,
            base_info: this.baseInfo(),
          }),
          signal: this.abortController.signal,
          label: 'getupdates',
          retries: 2,
          retryOnHttpError: true,
          timeoutMs: this.longPollTimeoutMs + 15_000,
        },
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as GetUpdatesResponse;

      // API omits ret/errcode on success; only check when explicitly present and non-zero
      if (data.ret !== undefined && data.ret !== 0) {
        const e: Error & { errcode?: number } = new Error(
          data.errmsg || `ret=${data.ret}`,
        );
        e.errcode = data.errcode;
        throw e;
      }

      // Honor the server-suggested long-poll window for the next round (clamped sanely),
      // instead of always assuming the hardcoded 45s.
      const serverMs = data.longpolling_timeout_ms;
      if (typeof serverMs === 'number' && Number.isFinite(serverMs) && serverMs > 0) {
        this.longPollTimeoutMs = Math.min(120_000, Math.max(10_000, serverMs + 5_000));
      }

      if (data.get_updates_buf) {
        this.pollCursor = data.get_updates_buf;
        savePollCursor(this.pollCursor, this.accountId);
      }

      return data.msgs || [];
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Message handling ──────────────────────────────────

  private async processMessage(msg: WeixinMessage): Promise<void> {
    // Only process user messages, skip bot echoes
    if (msg.message_type !== 1) return;

    // Drop long-poll re-deliveries so a command is never executed twice (at-most-once).
    if (!this.isFreshMessage(msg.from_user_id, msg.message_id)) {
      log.debug(`[msg] 跳过重复消息 message_id=${msg.message_id}`);
      return;
    }

    // Cache context_token for this user
    const previousTokenVersion = this.quota.snapshot(msg.from_user_id).tokenVersion;
    const inbound = this.quota.recordInbound(
      msg.from_user_id,
      String(msg.message_id),
      msg.context_token,
    );
    if (inbound.duplicate) {
      log.debug(`[msg] 持久化判重命中，跳过重放 message_id=${msg.message_id}`);
      return;
    }

    log.debug(
      `[msg] inbound message_id=${msg.message_id} user=${msg.from_user_id.substring(0, 12)}... `
      + `generation=${inbound.inboundGeneration} tokenVersion=${inbound.tokenVersion} `
      + `tokenChanged=${inbound.tokenVersion !== previousTokenVersion} tokenHash=${tokenHash(msg.context_token)}`,
    );
    const inboundText = msg.item_list
      .map((item) => item.text_item?.text || '')
      .join('');
    this.recordDiagnostic({
      event: 'inbound',
      accountId: this.accountId,
      userId: msg.from_user_id,
      contextToken: msg.context_token,
      inboundMessageId: String(msg.message_id),
      tokenChanged: inbound.tokenVersion !== previousTokenVersion,
      generation: inbound.inboundGeneration,
      tokenVersion: inbound.tokenVersion,
      itemCount: msg.item_list.length,
      jsLength: inboundText.length,
      utf8Bytes: Buffer.byteLength(inboundText, 'utf8'),
      itemListBytes: Buffer.byteLength(JSON.stringify(msg.item_list), 'utf8'),
    });

    const requeued = this.outbox.requeuePermanentFailures((item) => {
      if (item.accountId !== this.accountId || item.userId !== msg.from_user_id) return false;
      // Local quota failures are recoverable on any new, de-duplicated inbound.
      // The token may remain byte-identical, so this must not depend on a token
      // version change. The current token budget is still enforced by reserve().
      if (item.tokenVersion > inbound.tokenVersion) return false;
      return this.isLocalBudgetFailure(item);
    });
    if (requeued > 0) {
      log.warn(`[msg] 新入站已重新排队 ${requeued} 个本地预算阻塞项`);
    }

    this.contextTokens.set(msg.from_user_id, msg.context_token);
    saveContextTokens(this.contextTokens, this.accountId);

    // A real, deduplicated inbound message is the explicit recovery signal. It
    // clears only the local send backoff; quota counters and generations remain intact.
    this.resetRateLimitOnInbound(msg.from_user_id);

    log.debug(`[msg] item_list=${JSON.stringify(redactSecrets(msg.item_list))}`);
    const { text, refText, mediaItems } = await parseMessage(msg);

    // Preserve the state observed before the automatic drain. Any inbound
    // message can refresh the token; when durable text was waiting, the same
    // message must not also start a second Agent task after recovery.
    const pendingTextCountBeforeDrain = this.outbox.listPending(
      msg.from_user_id,
      this.accountId,
    ).filter((item) => !this.isRecoveryNotice(item)).length;

    if (pendingTextCountBeforeDrain > 0
      && this.quota.openInboundRecoveryWindow(msg.from_user_id)) {
      log.info(`[msg] 新入站已打开恢复发送窗口: ${msg.from_user_id.substring(0, 12)}...`);
    }

    // A new, deduplicated inbound message is the safe trigger for draining text
    // that was waiting for a usable context token or an ambiguous ret=-2 response.
    await this.drainOutbox(msg.from_user_id);

    if (!text && !refText && mediaItems.length === 0) return;

    log.debug(`收到 [${msg.from_user_id.substring(0, 12)}...]: ${text.substring(0, 60)}${mediaItems.length > 0 ? ` (+${mediaItems.length} media)` : ''}`);

    for (const handler of this.handlers) {
      try {
        handler(
          msg,
          text,
          refText,
          mediaItems.length > 0 ? mediaItems : undefined,
          pendingTextCountBeforeDrain > 0 ? { pendingTextCount: pendingTextCountBeforeDrain } : undefined,
        );
      } catch (err) {
        log.error('消息处理器异常:', err);
      }
    }
  }

  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId);
  }

  getDeliveryContext(userId: string): DeliveryContext {
    const snapshot = this.quota.snapshot(userId);
    return {
      generation: snapshot.inboundGeneration,
      tokenVersion: snapshot.tokenVersion,
    };
  }

  getDeliveryState(userId: string): { state: DeliveryState; waitingForInbound: boolean; pendingTextCount: number } {
    const allItems = this.outbox.list(userId, this.accountId);
    const pendingTextCount = allItems.filter((item) => (
      item.state === 'pending' && !this.isRecoveryNotice(item)
    )).length;
    const hasPermanentFailure = allItems.some((item) => item.state === 'permanent-failure');
    const state = hasPermanentFailure
      ? 'PERMANENT_FAILURE'
      : pendingTextCount > 0
        ? (this.deliveryStates.get(userId) || 'WAITING_INBOUND')
        : 'READY';
    return {
      state,
      // Derive from durable work as well, so a restarted process still gates
      // "继续" when an earlier send is waiting for a new inbound message.
      waitingForInbound: (this.waitingForInbound.has(userId) || pendingTextCount > 0)
        && pendingTextCount > 0,
      pendingTextCount,
    };
  }

  resumePendingText(userId: string): Promise<SendResult[]> {
    return this.drainOutbox(userId);
  }

  // ─── Sending ───────────────────────────────────────────

  private enqueueSend<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.sendQueues.get(userId) || Promise.resolve();
    const run = prev.then(task, task);
    const tracked = run.then(() => undefined, () => undefined);
    this.sendQueues.set(userId, tracked);
    return run.finally(() => {
      if (this.sendQueues.get(userId) === tracked) {
        this.sendQueues.delete(userId);
      }
    });
  }

  private getRateLimitState(userId: string): UserRateLimitState {
    const state = this.rateLimitStates.get(userId) || {
      consecutiveRet2: 0,
      suppressIntermediateUntil: 0,
      blockAllSendsUntil: 0,
    };
    this.rateLimitStates.set(userId, state);
    return state;
  }

  private resetRateLimitOnInbound(userId: string): void {
    const state = this.rateLimitStates.get(userId);
    // A new, deduplicated inbound is an explicit user recovery signal even if
    // the server repeats the same token string. This clears only transport
    // backoff; QuotaManager still keeps the token's item/byte counters intact.
    if (state) {
      state.consecutiveRet2 = 0;
      state.suppressIntermediateUntil = 0;
      state.blockAllSendsUntil = 0;
    }
    this.quota.clearRateBackoff(userId);
  }

  private nextCooldownMs(consecutiveRet2: number): number {
    // 2nd consecutive ret=-2 => 150s; then linear backoff up to ~7min.
    const steps = Math.max(0, consecutiveRet2 - 2);
    return Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, BASE_RATE_LIMIT_COOLDOWN_MS + steps * 60_000);
  }

  private gateSendWindow(userId: string, streamType: SendStreamType): boolean {
    const state = this.getRateLimitState(userId);
    const now = Date.now();
    const snapshot = this.quota.snapshot(userId);
    const persistedBackoff = this.quota.getRateBackoff(userId);

    const sameTokenBackoff = persistedBackoff.tokenVersion !== undefined
      && persistedBackoff.tokenVersion === snapshot.tokenVersion;
    const legacyBackoff = persistedBackoff.tokenVersion === undefined
      && now < persistedBackoff.until;
    if (sameTokenBackoff || legacyBackoff) {
      if (streamType === 'intermediate') {
        log.debug('[send] 中间消息命中持久化发送冷却，直接跳过');
      } else {
        log.debug(`[send] 命中持久化限流冷却窗口，等待新的入站消息: ${userId.substring(0, 12)}...`);
      }
      return false;
    }

    if (streamType === 'intermediate' && now < state.suppressIntermediateUntil) {
      log.debug(`[send] 跳过中间消息(保护模式): ${userId.substring(0, 12)}...`);
      return false;
    }

    if (now < state.blockAllSendsUntil) {
      if (streamType === 'intermediate') {
        log.debug('[send] 中间消息命中全局发送冷却，直接跳过');
        return false;
      }
      log.debug(`[send] 命中限流冷却窗口，等待新的入站消息: ${userId.substring(0, 12)}...`);
      return false;
    }

    return true;
  }

  async sendText(
    userId: string,
    text: string,
    options?: {
      streamType?: SendStreamType;
      priority?: OutboxPriority;
      generation?: number;
      tokenVersion?: number;
    },
  ): Promise<SendResult[]> {
    const streamType = options?.streamType || 'regular';
    const priority = options?.priority || (streamType === 'intermediate' ? 'intermediate' : 'control');
    const snapshot = this.quota.snapshot(userId);
    const generation = options?.generation ?? snapshot.inboundGeneration;
    const tokenVersion = options?.tokenVersion ?? snapshot.tokenVersion;
    const capacityFailures: SendResult[] = [];
    const chunks = chunkUtf8Text(text, 2_000);

    try {
      const batchId = chunks.length > 1 ? randomUUID() : undefined;
      this.outbox.enqueueTextBatch(chunks.map((chunk) => ({
        accountId: this.accountId,
        userId,
        generation,
        tokenVersion,
        priority,
        batchId,
        text: chunk,
      })));
    } catch (err) {
      for (const chunk of chunks) {
        log.error(`[send] 文本进入 outbox 失败: ${userId}`, err);
        capacityFailures.push({
          status: priority === 'activity' || priority === 'intermediate' ? 'suppressed' : 'permanent-failure',
          itemId: 'outbox-capacity',
          userId,
          generation,
          tokenVersion,
          attemptedBytes: Buffer.byteLength(chunk, 'utf8'),
          error: { errmsg: err instanceof Error ? err.message : String(err) },
        });
      }
      if (priority === 'final') {
        this.enqueueVisibleFailureNotice({
          itemId: `outbox-capacity:${this.accountId}:${userId}:${generation}:${tokenVersion}`,
          userId,
          generation,
          tokenVersion,
          priority,
        }, { errmsg: err instanceof Error ? err.message : String(err) });
      }
    }

    return [...capacityFailures, ...(await this.drainOutbox(userId, streamType))];
  }

  private drainOutbox(userId: string, streamType: SendStreamType = 'regular'): Promise<SendResult[]> {
    return this.enqueueSend(userId, () => this.drainOutboxNow(userId, streamType));
  }

  private async drainOutboxNow(userId: string, streamType: SendStreamType): Promise<SendResult[]> {
    let items = this.outbox.listPending(userId, this.accountId);
    this.cleanupOrphanedRecoveryNotices(items);
    items = this.outbox.listPending(userId, this.accountId);
    const token = this.contextTokens.get(userId);
    if (!token) {
      if (items.length > 0) {
        this.waitingForInbound.add(userId);
        this.deliveryStates.set(userId, 'WAITING_INBOUND');
      }
      for (const item of items) {
        this.recordQueuedDiagnostic(item, { errmsg: '缺少 context_token' });
      }
      return items.map((item) => this.resultForItem(item, 'waiting-for-token'));
    }
    if (items.length === 0) {
      this.waitingForInbound.delete(userId);
      const hasPermanentFailure = this.outbox.list(userId, this.accountId)
        .some((item) => item.state === 'permanent-failure');
      if (!hasPermanentFailure) this.deliveryStates.set(userId, 'READY');
      return [];
    }

    this.deliveryStates.set(userId, 'SENDING');
    const results: SendResult[] = [];
    let finalDelivered = false;
    for (const item of items) {
      // A previous item may have removed this snapshot entry (for example, a
      // recovery notice cleared after its original result was confirmed).
      if (!this.outbox.get(item.itemId)) continue;

      // A notice is useful only while the item that caused it is durable. Older
      // versions could leave the notice behind after that item was evicted or
      // acknowledged, which would send a misleading warning after the final result.
      if (item.priority === 'control' && item.itemId.startsWith('delivery-notice:')
        && !this.outbox.get(item.itemId.slice('delivery-notice:'.length))) {
        this.outbox.ack(item.itemId);
        continue;
      }
      if (item.priority === 'control' && item.itemId.startsWith('token-budget-notice:')
        && finalDelivered) {
        this.outbox.ack(item.itemId);
        continue;
      }

      // A final text may have multiple UTF-8 chunks. Never send a partial final
      // batch merely because the last chunk is the one that crosses the local
      // token guard.
      const batchItems = item.batchId
        ? items.filter((candidate) => candidate.batchId === item.batchId
          && candidate.priority === item.priority
          && this.outbox.get(candidate.itemId))
        : [item];
      const remainingItems = this.quota.getTokenBudget(userId).remainingItems;
      const needsRecovery = item.priority !== 'control'
        && (remainingItems <= 1
          || (item.priority === 'final' && batchItems.length > remainingItems));
      if (needsRecovery) {
        const noticeResult = await this.sendRecoveryNotice(userId, item);
        if (noticeResult) results.push(noticeResult);
        const queueError = {
          errmsg: '最终结果已排队，等待新的 context_token',
        };
        this.recordQueuedDiagnostic(item, queueError);
        results.push(this.resultForItem(item, 'queued', queueError));
        this.quota.noteRateBackoff(userId, Date.now() + BASE_RATE_LIMIT_COOLDOWN_MS);
        this.deliveryStates.set(userId, 'WAITING_INBOUND');
        break;
      }

      const reservation = this.quota.reserve(userId, item.bytes, item.priority);
      if (!reservation.allowed) {
        if (reservation.reason === 'intermediate-budget') {
          const noticeResult = await this.sendRecoveryNotice(userId, item);
          if (noticeResult) results.push(noticeResult);
          const queueError = {
            errmsg: '已达到本地中间消息预算，等待新的 context_token 后自动续发',
          };
          this.recordQueuedDiagnostic(item, queueError);
          results.push(this.resultForItem(item, 'queued', queueError));
          this.quota.noteRateBackoff(userId, Date.now() + BASE_RATE_LIMIT_COOLDOWN_MS);
          this.deliveryStates.set(userId, 'WAITING_INBOUND');
          break;
        }
        if (reservation.reason === 'token-budget-exhausted') {
          this.quota.noteRateBackoff(userId, Date.now() + BASE_RATE_LIMIT_COOLDOWN_MS);
          this.deliveryStates.set(userId, 'RATE_BACKOFF');
          try {
            if (this.quota.claimTokenBudgetNotice(userId)) {
              this.outbox.enqueueText({
                itemId: `delivery-notice:${item.itemId}`,
                accountId: this.accountId,
                userId,
                generation: item.generation,
                tokenVersion: item.tokenVersion,
                priority: 'control',
                text: '最终结果已排队，等待新的 context_token 后自动续发。',
              });
            }
          } catch (noticeError) {
            log.error(`[send] 无法写入最终结果恢复提示: ${userId}`, noticeError);
          }
          const queueError = {
            errmsg: '当前 token 的最终发送预算已用尽，等待新的 context_token',
          };
          this.recordQueuedDiagnostic(item, queueError);
          results.push(this.resultForItem(item, 'queued', queueError));
          break;
        }
        if (reservation.reason === 'final-reserved' || reservation.reason === 'budget-exhausted') {
          const noticeResult = await this.sendRecoveryNotice(userId, item);
          if (noticeResult) results.push(noticeResult);
          const queueError = {
            errmsg: `本地发送预算暂时不足: ${reservation.reason}，等待新的 context_token 后自动续发`,
          };
          this.recordQueuedDiagnostic(item, queueError);
          results.push(this.resultForItem(item, 'queued', queueError));
          this.quota.noteRateBackoff(userId, Date.now() + BASE_RATE_LIMIT_COOLDOWN_MS);
          this.deliveryStates.set(userId, 'WAITING_INBOUND');
          break;
        }

        this.outbox.markPermanentFailure(item.itemId, {
          errmsg: `本地发送预算不足: ${reservation.reason}`,
        });
        results.push(this.resultForItem(item, 'permanent-failure', {
          errmsg: `本地发送预算不足: ${reservation.reason}`,
        }));
        continue;
      }

      if (!this.gateSendWindow(userId, item.priority === 'intermediate' || item.priority === 'activity'
        ? 'intermediate'
        : streamType)) {
        this.quota.release(reservation.reservation.reservationId);
        this.deliveryStates.set(userId, 'RATE_BACKOFF');
        const queueError = { ret: -2, errmsg: '发送冷却中，等待新的入站消息' };
        this.recordQueuedDiagnostic(item, queueError);
        results.push(this.resultForItem(item, 'rate-limited', queueError));
        break;
      }

      try {
        log.debug(`[send] item=${item.itemId} client=${item.clientId} user=${userId.substring(0, 12)}... generation=${item.generation} tokenVersion=${item.tokenVersion} priority=${item.priority} bytes=${item.bytes}`);
        await this.sendRawMessageWithRetry(
          userId,
          token,
          [{ type: 1 as const, text_item: { text: item.text } }],
          item.priority === 'intermediate' || item.priority === 'activity' ? 'intermediate' : streamType,
          item.clientId,
          {
            itemId: item.itemId,
            itemSequence: item.sequence,
            bubbleSequence: item.sequence,
            generation: item.generation,
            tokenVersion: item.tokenVersion,
            priority: item.priority,
          },
        );
        this.quota.commit(reservation.reservation.reservationId);
        this.outbox.ack(item.itemId);
        this.outbox.ack(`delivery-notice:${item.itemId}`);
        if (item.priority === 'final') {
          finalDelivered = true;
          // Once the final result is confirmed, stale streamed output from the
          // same task must never be appended after it on a later recovery.
          this.outbox.supersedeIntermediate(this.accountId, userId, item.generation);
        }
        results.push(this.resultForItem(item, 'sent'));
      } catch (err) {
        this.quota.release(reservation.reservation.reservationId);
        const details = this.errorDetails(err);
        const failure = classifyApiFailure(details);
        if (failure?.ambiguous) {
          this.noteRateLimit(userId);
          if (item.priority !== 'control') {
            try {
              this.outbox.enqueueText({
                itemId: `delivery-notice:${item.itemId}`,
                accountId: this.accountId,
                userId,
                generation: item.generation,
                tokenVersion: item.tokenVersion,
                priority: 'control',
                text: `消息发送暂时受限，收到新的消息后自动续发。原始错误: ${details.errmsg || `ret=${details.ret ?? 'unknown'}`}`,
              });
            } catch (noticeError) {
              log.error(`[send] 无法写入恢复提示: ${userId}`, noticeError);
            }
          }
          this.deliveryStates.set(userId, 'RATE_BACKOFF');
        } else if (this.isUnconfirmedResponse(details)) {
          if (item.priority !== 'control') {
            try {
              this.outbox.enqueueText({
                itemId: `delivery-notice:${item.itemId}`,
                accountId: this.accountId,
                userId,
                generation: item.generation,
                tokenVersion: item.tokenVersion,
                priority: 'control',
                text: '消息发送结果暂未确认，收到新的消息后自动续发。',
              });
            } catch (noticeError) {
              log.error(`[send] 无法写入未确认恢复提示: ${userId}`, noticeError);
            }
          }
          this.quota.noteRateBackoff(userId, Date.now() + BASE_RATE_LIMIT_COOLDOWN_MS);
          this.deliveryStates.set(userId, 'WAITING_INBOUND');
        } else {
          this.outbox.markPermanentFailure(item.itemId, details);
          this.enqueueVisibleFailureNotice(item, details);
          this.deliveryStates.set(userId, 'PERMANENT_FAILURE');
        }
        if (failure?.ambiguous || this.isUnconfirmedResponse(details)) {
          this.recordQueuedDiagnostic(item, details);
        }
        results.push(this.resultForItem(
          item,
          failure?.status || (this.isUnconfirmedResponse(details) ? 'queued' : 'permanent-failure'),
          details,
        ));
        // Keep the item durable and wait for a fresh inbound message before trying again.
        break;
      }
    }
    if (this.outbox.listPending(userId, this.accountId).length > 0) {
      this.waitingForInbound.add(userId);
      if (this.deliveryStates.get(userId) === 'SENDING') {
        this.deliveryStates.set(userId, 'WAITING_INBOUND');
      }
    } else {
      this.waitingForInbound.delete(userId);
      const hasPermanentFailure = this.outbox.list(userId, this.accountId)
        .some((item) => item.state === 'permanent-failure');
      if (!hasPermanentFailure) this.deliveryStates.set(userId, 'READY');
    }
    return results;
  }

  private isRecoveryNotice(item: OutboxTextItem): boolean {
    return item.priority === 'control'
      && (item.itemId.startsWith('token-budget-notice:')
        || item.itemId.startsWith('delivery-notice:'));
  }

  private cleanupOrphanedRecoveryNotices(items: OutboxTextItem[]): void {
    const payloadItems = items.filter((item) => !this.isRecoveryNotice(item));
    for (const item of items) {
      if (!this.isRecoveryNotice(item)) continue;

      if (item.itemId.startsWith('delivery-notice:')) {
        const targetId = item.itemId.slice('delivery-notice:'.length);
        if (!this.outbox.get(targetId)) this.outbox.ack(item.itemId);
        continue;
      }

      // A token-budget notice has no single target. It is valid only while
      // there is durable non-notice output waiting behind it.
      if (payloadItems.length === 0) this.outbox.ack(item.itemId);
    }
  }

  private async sendRecoveryNotice(userId: string, triggerItem: OutboxTextItem): Promise<SendResult | undefined> {
    const noticeId = `token-budget-notice:${tokenHash(this.accountId)}:${tokenHash(userId)}:${triggerItem.tokenVersion}`;
    let notice = this.outbox.get(noticeId);
    if (!notice) {
      if (!this.quota.claimTokenBudgetNotice(userId)) return undefined;
      const pendingCount = this.outbox.listPending(userId, this.accountId)
        .filter((item) => item.itemId !== noticeId)
        .length;
      try {
        notice = this.outbox.enqueueText({
          itemId: noticeId,
          accountId: this.accountId,
          userId,
          generation: triggerItem.generation,
          tokenVersion: triggerItem.tokenVersion,
          priority: 'control',
          text: RECOVERY_NOTICE_TEXT(pendingCount),
        });
      } catch (err) {
        log.error(`[send] 无法写入恢复提示: ${userId}`, err);
        return undefined;
      }
    }

    const token = this.contextTokens.get(userId);
    if (!token) return this.resultForItem(notice, 'waiting-for-token', { errmsg: '缺少 context_token' });

    const reservation = this.quota.reserve(userId, notice.bytes, 'control', {
      generation: notice.generation,
      tokenVersion: notice.tokenVersion,
    });
    if (!reservation.allowed) {
      return this.resultForItem(notice, 'queued', {
        errmsg: `恢复提示发送预算不足: ${reservation.reason}`,
      });
    }
    if (!this.gateSendWindow(userId, 'regular')) {
      this.quota.release(reservation.reservation.reservationId);
      return this.resultForItem(notice, 'rate-limited', {
        ret: -2,
        errmsg: '恢复提示等待新的入站消息',
      });
    }

    try {
      log.debug(`[send] recovery notice item=${notice.itemId} client=${notice.clientId}`);
      await this.sendRawMessageWithRetry(
        userId,
        token,
        [{ type: 1 as const, text_item: { text: notice.text } }],
        'regular',
        notice.clientId,
        {
          itemId: notice.itemId,
          itemSequence: notice.sequence,
          bubbleSequence: notice.sequence,
          generation: notice.generation,
          tokenVersion: notice.tokenVersion,
          priority: notice.priority,
        },
      );
      this.quota.commit(reservation.reservation.reservationId);
      this.outbox.ack(notice.itemId);
      return this.resultForItem(notice, 'sent');
    } catch (err) {
      this.quota.release(reservation.reservation.reservationId);
      const details = this.errorDetails(err);
      const failure = classifyApiFailure(details);
      if (failure?.ambiguous) this.noteRateLimit(userId);
      else if (!this.isUnconfirmedResponse(details)) this.outbox.markPermanentFailure(notice.itemId, details);
      return this.resultForItem(notice, failure?.status || (this.isUnconfirmedResponse(details) ? 'queued' : 'permanent-failure'), details);
    }
  }

  private resultForItem(
    item: { itemId: string; userId: string; generation: number; tokenVersion: number; bytes: number },
    status: SendResult['status'],
    error?: ApiErrorDetails,
  ): SendResult {
    return {
      status,
      itemId: item.itemId,
      userId: item.userId,
      generation: item.generation,
      tokenVersion: item.tokenVersion,
      attemptedBytes: item.bytes,
      ...(error ? { error } : {}),
    };
  }

  private enqueueVisibleFailureNotice(
    item: {
      itemId: string;
      userId: string;
      generation: number;
      tokenVersion: number;
      priority: OutboxPriority;
    },
    details: ApiErrorDetails,
  ): void {
    if (item.priority !== 'final' || item.itemId.startsWith('delivery-failure:')) return;
    const rawError = details.errmsg
      || [details.ret !== undefined ? `ret=${details.ret}` : '', details.errcode !== undefined ? `errcode=${details.errcode}` : '']
        .filter(Boolean)
        .join(' ')
      || 'unknown error';
    try {
      this.outbox.enqueueText({
        itemId: `delivery-failure:${item.itemId}`,
        accountId: this.accountId,
        userId: item.userId,
        generation: item.generation,
        tokenVersion: item.tokenVersion,
        priority: 'control',
        text: `最终结果未送达，原始结果已保留为失败记录。请重新发送任务。原始错误: ${rawError}`,
      });
    } catch (noticeError) {
      log.error(`[send] 无法写入最终结果失败提示: ${item.userId}`, noticeError);
    }
  }

  private errorDetails(err: unknown): ApiErrorDetails {
    if (err instanceof ILinkApiError) return err.details;
    return { errmsg: err instanceof Error ? err.message : String(err) };
  }

  private isUnconfirmedResponse(details: ApiErrorDetails): boolean {
    return details.errmsg === UNCONFIRMED_SEND_RESPONSE
      || details.errmsg === LEGACY_MISSING_RET_ERROR;
  }

  private isLocalBudgetFailure(item: Pick<OutboxTextItem, 'terminalError'>): boolean {
    const errmsg = item.terminalError?.errmsg;
    return errmsg?.startsWith('本地发送预算不足: ') === true
      || errmsg?.startsWith('本地发送预算暂时不足: ') === true;
  }

  private recordDiagnostic(input: DeliveryDiagnosticInput): void {
    if (!this.diagnostics) return;
    try {
      this.diagnostics.record(input);
    } catch (err) {
      log.warn('[send] 持久化发送诊断失败:', err);
    }
  }

  private recordQueuedDiagnostic(
    item: Pick<OutboxTextItem, 'itemId' | 'clientId' | 'sequence' | 'userId' | 'generation' | 'tokenVersion' | 'priority' | 'bytes'>,
    error: ApiErrorDetails,
  ): void {
    this.recordDiagnostic({
      event: 'queued',
      accountId: this.accountId,
      userId: item.userId,
      contextToken: this.contextTokens.get(item.userId),
      clientId: item.clientId,
      itemId: item.itemId,
      itemSequence: item.sequence,
      bubbleSequence: item.sequence,
      generation: item.generation,
      tokenVersion: item.tokenVersion,
      priority: item.priority,
      utf8Bytes: item.bytes,
      response: error,
    });
  }

  private noteRateLimit(userId: string): void {
    const state = this.getRateLimitState(userId);
    state.consecutiveRet2 += 1;
    const until = Date.now() + this.nextCooldownMs(state.consecutiveRet2);
    state.blockAllSendsUntil = Math.max(state.blockAllSendsUntil, until);
    state.suppressIntermediateUntil = Math.max(state.suppressIntermediateUntil, until);
    this.quota.noteRateBackoff(userId, until);
    this.deliveryStates.set(userId, 'RATE_BACKOFF');
    log.warn('[send] ret=-2 歧义响应，暂停同 token 重试，等待新的 context_token');
  }

  private async sendRawMessageWithRetry(
    userId: string,
    contextToken: string,
    itemList: MessageItem[],
    streamType: SendStreamType = 'regular',
    clientId: string = randomUUID(),
    trace?: DeliveryTraceContext,
  ): Promise<void> {
    const state = this.getRateLimitState(userId);
    if (!this.gateSendWindow(userId, streamType)) {
      this.recordDiagnostic({
        event: 'skipped',
        accountId: this.accountId,
        userId,
        contextToken,
        clientId,
        ...trace,
        itemCount: itemList.length,
        jsLength: itemList.map((item) => item.text_item?.text || '').join('').length,
        utf8Bytes: Buffer.byteLength(itemList.map((item) => item.text_item?.text || '').join(''), 'utf8'),
        itemListBytes: Buffer.byteLength(JSON.stringify(itemList), 'utf8'),
        response: { ret: -2, errmsg: '发送冷却中，等待新的入站消息' },
      });
      throw new ILinkApiError({ ret: -2, errmsg: '发送冷却中，等待新的入站消息' });
    }

    await this.sendRawMessage(userId, contextToken, itemList, clientId, trace);
    state.consecutiveRet2 = 0;
    state.blockAllSendsUntil = 0;
  }

  private async sendRawMessage(
    userId: string,
    contextToken: string,
    itemList: MessageItem[],
    clientId: string = randomUUID(),
    trace?: DeliveryTraceContext,
  ): Promise<void> {
    const serializedItems = JSON.stringify(itemList);
    const textItems = itemList
      .map((item) => item.text_item?.text || '')
      .join('');
    const diagnosticBase: DeliveryDiagnosticInput = {
      event: 'request',
      accountId: this.accountId,
      userId,
      contextToken,
      clientId,
      ...trace,
      itemCount: itemList.length,
      jsLength: textItems.length,
      utf8Bytes: Buffer.byteLength(textItems, 'utf8'),
      itemListBytes: Buffer.byteLength(serializedItems, 'utf8'),
    };
    this.recordDiagnostic(diagnosticBase);
    log.debug(
      `[send] request client=${clientId} user=${userId.substring(0, 12)}... `
      + `tokenHash=${tokenHash(contextToken)} items=${itemList.length} `
      + `jsLength=${textItems.length} utf8Bytes=${Buffer.byteLength(textItems, 'utf8')} `
      + `itemListBytes=${Buffer.byteLength(serializedItems, 'utf8')}`,
    );
    let responseRecorded = false;
    try {
      const res = await fetchWithRetry(
        `${this.credentials.baseUrl}/ilink/bot/sendmessage`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            msg: {
              from_user_id: '',
              to_user_id: userId,
              client_id: clientId,
              message_type: 2,
              message_state: 2,
              context_token: contextToken,
              item_list: itemList,
            },
            base_info: this.baseInfo(),
          }),
          label: 'send',
          retries: 2,
          timeoutMs: 30_000,
        },
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const response = { httpStatus: res.status, errmsg: `HTTP ${res.status}` };
        this.recordDiagnostic({ ...diagnosticBase, event: 'response', response });
        responseRecorded = true;
        throw new ILinkApiError({ httpStatus: res.status, errmsg: `发送消息失败: HTTP ${res.status} ${body}` });
      }

      const rawBody = await res.text();
      let data: Partial<SendMessageResponse>;
      try {
        data = (rawBody ? JSON.parse(rawBody) : {}) as Partial<SendMessageResponse>;
      } catch {
        log.error(`[send] response parse failed client=${clientId} http=${res.status} bodyBytes=${Buffer.byteLength(rawBody, 'utf8')}`);
        const response = { httpStatus: res.status, errmsg: 'sendmessage response was not valid JSON' };
        this.recordDiagnostic({ ...diagnosticBase, event: 'response', response });
        responseRecorded = true;
        throw new ILinkApiError({
          httpStatus: res.status,
          errmsg: 'sendmessage response was not valid JSON',
        });
      }
      const response = {
        ret: data.ret,
        errcode: data.errcode,
        errmsg: data.errmsg
          ?? (data.ret === undefined && data.message_id === undefined
            ? UNCONFIRMED_SEND_RESPONSE
            : undefined),
        messageId: data.message_id,
        httpStatus: res.status,
      };
      this.recordDiagnostic({ ...diagnosticBase, event: 'response', response });
      responseRecorded = true;
      log.debug(`[send] response client=${clientId} http=${res.status} bodyBytes=${Buffer.byteLength(rawBody, 'utf8')} json=${JSON.stringify(redactSecrets(data))}`);
      // Some iLink responses omit ret/errcode but include message_id. Treat that
      // as confirmed success. An empty success body has no delivery evidence and
      // must remain durable so a later inbound message can retry the same item.
      if (data.ret !== undefined && data.ret !== 0) {
        throw new ILinkApiError({ ret: data.ret, errcode: data.errcode, errmsg: data.errmsg || `ret=${data.ret}` });
      }
      if (data.ret !== 0 && data.message_id === undefined) {
        throw new ILinkApiError({ httpStatus: res.status, errmsg: UNCONFIRMED_SEND_RESPONSE });
      }
    } catch (err) {
      if (!responseRecorded) {
        const details = this.errorDetails(err);
        this.recordDiagnostic({
          ...diagnosticBase,
          event: 'error',
          response: {
            ret: details.ret,
            errcode: details.errcode,
            errmsg: details.errmsg?.slice(0, 500),
            httpStatus: details.httpStatus,
          },
        });
      }
      throw err;
    }
  }

  // ─── File/Image/Video Upload & Send ──────────────────────

  async sendFile(
    userId: string,
    filePath: string,
    title?: string,
    deliveryContext?: DeliveryContext,
  ): Promise<SendResult[]> {
    const token = this.contextTokens.get(userId);
    if (!token) {
      log.error(`无法发送文件给 ${userId}: 缺少 context_token`);
      return [this.mediaResult(userId, 'waiting-for-token', { errmsg: '缺少 context_token' })];
    }

    if (!existsSync(filePath)) {
      return [this.mediaResult(userId, 'permanent-failure', { errmsg: `文件不存在: ${filePath}` })];
    }

    const bytes = statSync(filePath).size;
    const reservation = this.quota.reserve(userId, bytes, 'media', deliveryContext);
    if (!reservation.allowed) {
      return [this.mediaResult(userId,
        reservation.reason === 'final-reserved' ? 'suppressed' : 'permanent-failure',
        { errmsg: `媒体发送预算不足: ${reservation.reason}` })];
    }

    try {
      const upload = await this.uploadToCdn(userId, filePath, UPLOAD_MEDIA_TYPE_FILE);
      const fileName = title || basename(filePath);
      const itemList: MessageItem[] = [{
        type: 4,
        file_item: {
          file_name: fileName,
          len: String(upload.rawsize),
          media: {
            encrypt_query_param: upload.downloadParam,
            aes_key: encodeMessageAesKey(upload.aeskey),
            encrypt_type: 1,
          },
        },
      }];
      const result = await this.sendMediaMessage(userId, token, itemList, upload.rawsize, reservation.reservation);
      if (result[0]?.status === 'sent') log.info(`[sendFile] 已发送: ${fileName}`);
      return result;
    } catch (err) {
      this.quota.release(reservation.reservation.reservationId);
      log.error(`[sendFile] 发送失败: ${filePath}`, err);
      return [this.mediaFailureResult(userId, err)];
    }
  }

  async sendImage(
    userId: string,
    imagePath: string,
    caption?: string,
    deliveryContext?: DeliveryContext,
  ): Promise<SendResult[]> {
    const token = this.contextTokens.get(userId);
    if (!token) {
      log.error(`无法发送图片给 ${userId}: 缺少 context_token`);
      return [this.mediaResult(userId, 'waiting-for-token', { errmsg: '缺少 context_token' })];
    }

    if (!existsSync(imagePath)) {
      return [this.mediaResult(userId, 'permanent-failure', { errmsg: `图片不存在: ${imagePath}` })];
    }

    const bytes = statSync(imagePath).size + (caption ? Buffer.byteLength(caption, 'utf8') : 0);
    const reservation = this.quota.reserve(userId, bytes, 'media', deliveryContext);
    if (!reservation.allowed) {
      return [this.mediaResult(userId,
        reservation.reason === 'final-reserved' ? 'suppressed' : 'permanent-failure',
        { errmsg: `媒体发送预算不足: ${reservation.reason}` })];
    }

    try {
      const upload = await this.uploadToCdn(userId, imagePath, UPLOAD_MEDIA_TYPE_IMAGE);
      const itemList: MessageItem[] = [];
      if (caption) itemList.push({ type: 1, text_item: { text: caption } });
      itemList.push({
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: upload.downloadParam,
            aes_key: encodeMessageAesKey(upload.aeskey),
            encrypt_type: 1,
          },
          mid_size: upload.filesize,
        },
      });
      const result = await this.sendMediaMessage(
        userId,
        token,
        itemList,
        bytes,
        reservation.reservation,
      );
      if (result[0]?.status === 'sent') log.info(`[sendImage] 已发送图片: ${basename(imagePath)}`);
      return result;
    } catch (err) {
      this.quota.release(reservation.reservation.reservationId);
      log.error(`[sendImage] 发送失败: ${imagePath}`, err);
      return [this.mediaFailureResult(userId, err)];
    }
  }

  async sendVideo(userId: string, videoPath: string, deliveryContext?: DeliveryContext): Promise<SendResult[]> {
    const token = this.contextTokens.get(userId);
    if (!token) {
      log.error(`无法发送视频给 ${userId}: 缺少 context_token`);
      return [this.mediaResult(userId, 'waiting-for-token', { errmsg: '缺少 context_token' })];
    }

    if (!existsSync(videoPath)) {
      return [this.mediaResult(userId, 'permanent-failure', { errmsg: `视频不存在: ${videoPath}` })];
    }

    const bytes = statSync(videoPath).size;
    const reservation = this.quota.reserve(userId, bytes, 'media', deliveryContext);
    if (!reservation.allowed) {
      return [this.mediaResult(userId,
        reservation.reason === 'final-reserved' ? 'suppressed' : 'permanent-failure',
        { errmsg: `媒体发送预算不足: ${reservation.reason}` })];
    }

    try {
      const upload = await this.uploadToCdn(userId, videoPath, UPLOAD_MEDIA_TYPE_VIDEO);
      const itemList: MessageItem[] = [{
        type: 5,
        video_item: {
          media: {
            encrypt_query_param: upload.downloadParam,
            aes_key: encodeMessageAesKey(upload.aeskey),
            encrypt_type: 1,
          },
          video_size: upload.filesize,
        },
      }];
      const result = await this.sendMediaMessage(userId, token, itemList, upload.rawsize, reservation.reservation);
      if (result[0]?.status === 'sent') log.info(`[sendVideo] 已发送视频: ${basename(videoPath)}`);
      return result;
    } catch (err) {
      this.quota.release(reservation.reservation.reservationId);
      log.error(`[sendVideo] 发送失败: ${videoPath}`, err);
      return [this.mediaFailureResult(userId, err)];
    }
  }

  private mediaResult(userId: string, status: SendResult['status'], error?: ApiErrorDetails): SendResult {
    const snapshot = this.quota.snapshot(userId);
    return {
      status,
      itemId: `media-${randomUUID()}`,
      userId,
      generation: snapshot.inboundGeneration,
      tokenVersion: snapshot.tokenVersion,
      attemptedBytes: 0,
      ...(error ? { error } : {}),
    };
  }

  private mediaFailureResult(userId: string, err: unknown): SendResult {
    const details = this.errorDetails(err);
    const failure = classifyApiFailure(details);
    if (failure?.ambiguous) this.noteRateLimit(userId);
    return this.mediaResult(userId, failure?.status || 'permanent-failure', details);
  }

  private async sendMediaMessage(
    userId: string,
    contextToken: string,
    itemList: MessageItem[],
    bytes: number,
    reservation: QuotaReservation,
  ): Promise<SendResult[]> {
    return this.enqueueSend(userId, async () => {
      const item = {
        itemId: `media-${randomUUID()}`,
        userId,
        generation: reservation.generation,
        tokenVersion: reservation.tokenVersion,
        bytes,
      };
      try {
        await this.sendRawMessageWithRetry(
          userId,
          contextToken,
          itemList,
          'regular',
          item.itemId,
          {
            itemId: item.itemId,
            generation: item.generation,
            tokenVersion: item.tokenVersion,
            priority: 'media',
          },
        );
        this.quota.commit(reservation.reservationId);
        return [this.resultForItem(item, 'sent')];
      } catch (err) {
        this.quota.release(reservation.reservationId);
        const details = this.errorDetails(err);
        const failure = classifyApiFailure(details);
        if (failure?.ambiguous) this.noteRateLimit(userId);
        return [this.resultForItem(item, failure?.status || 'permanent-failure', details)];
      }
    });
  }

  private async uploadToCdn(
    userId: string,
    filePath: string,
    mediaType: number,
  ): Promise<{ rawsize: number; filesize: number; aeskey: Buffer; downloadParam: string }> {
    const plaintext = readFileSync(filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = md5(plaintext);
    const filesize = aesEcbPaddedSize(rawsize);

    const filekey = randomBytes(16).toString('hex');
    const aeskey = randomBytes(16);

    // Get upload URL from iLink
    const uploadResp = await fetchWithRetry(
      `${this.credentials.baseUrl}/ilink/bot/getuploadurl`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          filekey,
          media_type: mediaType,
          to_user_id: userId,
          rawsize,
          rawfilemd5,
          filesize,
          aeskey: aeskey.toString('hex'),
          no_need_thumb: true,
          base_info: this.baseInfo(),
        }),
        label: 'getuploadurl',
        retries: 2,
        timeoutMs: 30_000,
      },
    );

    if (!uploadResp.ok) {
      const body = await uploadResp.text().catch(() => '');
      throw new ILinkApiError({ httpStatus: uploadResp.status, errmsg: `获取上传URL失败: HTTP ${uploadResp.status} ${body}` });
    }

    const uploadData = (await uploadResp.json()) as {
      upload_param?: string;
      ret?: number;
      errcode?: number;
      errmsg?: string;
    };
    if (uploadData.ret !== undefined && uploadData.ret !== 0) {
      throw new ILinkApiError({ ret: uploadData.ret, errcode: uploadData.errcode, errmsg: uploadData.errmsg });
    }
    const uploadParam = uploadData.upload_param;
    if (!uploadParam) {
      throw new ILinkApiError({ errmsg: '获取上传URL失败: 无 upload_param' });
    }

    // Encrypt and upload to CDN
    const ciphertext = encryptAesEcb(plaintext, aeskey);
    const cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

    log.debug(`[upload] Uploading to CDN: ${rawsize} bytes`);

    const cdnResp = await fetchWithRetry(cdnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(ciphertext),
      label: 'cdn-upload',
      retries: 2,
      timeoutMs: 60_000, // large files need a longer per-attempt window
    });

    if (!cdnResp.ok) {
      const body = await cdnResp.text().catch(() => '');
      throw new ILinkApiError({ httpStatus: cdnResp.status, errmsg: `CDN 上传失败: HTTP ${cdnResp.status} ${body}` });
    }

    const downloadParam = cdnResp.headers.get('x-encrypted-param');
    if (!downloadParam) {
      throw new ILinkApiError({ errmsg: 'CDN 上传失败: 无 x-encrypted-param' });
    }

    log.debug(`[upload] CDN upload success, downloadParam: ${downloadParam.substring(0, 30)}...`);

    return { rawsize, filesize, aeskey, downloadParam };
  }

  // ─── Typing indicator ─────────────────────────────────

  async startTyping(userId: string): Promise<() => void> {
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) return () => {};

    try {
      const ticket = await this.getTypingTicket(userId, contextToken);
      if (!ticket) return () => {};

      await this.sendTypingStatus(userId, ticket, 1).catch(() => {});

      const interval = setInterval(() => {
        this.sendTypingStatus(userId, ticket, 1).catch(() => {});
      }, 5000);

      return () => {
        clearInterval(interval);
        this.sendTypingStatus(userId, ticket, 2).catch(() => {});
      };
    } catch {
      return () => {};
    }
  }

  private async getTypingTicket(
    userId: string,
    contextToken: string,
  ): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached && Date.now() - cached.ts < 20 * 3600_000) {
      return cached.ticket;
    }

    const res = await fetchWithRetry(
      `${this.credentials.baseUrl}/ilink/bot/getconfig`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          ilink_user_id: userId,
          context_token: contextToken,
          base_info: this.baseInfo(),
        }),
        label: 'getconfig',
        retries: 1,
        timeoutMs: 15_000,
      },
    );

    if (!res.ok) return null;

    const data = (await res.json()) as GetConfigResponse;
    if (data.ret !== 0 || !data.typing_ticket) return null;

    this.typingTickets.set(userId, {
      ticket: data.typing_ticket,
      ts: Date.now(),
    });
    return data.typing_ticket;
  }

  private async sendTypingStatus(
    userId: string,
    ticket: string,
    status: 1 | 2,
  ): Promise<void> {
    // Fire-and-forget heartbeat (every ~5s); a timeout prevents hung sockets from piling up.
    await fetchWithRetry(`${this.credentials.baseUrl}/ilink/bot/sendtyping`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        ilink_user_id: userId,
        typing_ticket: ticket,
        status,
        base_info: this.baseInfo(),
      }),
      label: 'sendtyping',
      retries: 0,
      timeoutMs: 10_000,
    });
  }
}

// ─── Helpers ───────────────────────────────────────────────

const SECRET_KEYS = new Set([
  'aes_key', 'aeskey', 'encrypt_query_param', 'full_url', 'url',
]);

/** Deep-clone a value while masking secret fields by name, so DEBUG logs never leak
 *  media decryption keys / signed CDN URLs that could be replayed. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase())
        ? (typeof v === 'string' && v.length > 0 ? '***' : v)
        : redactSecrets(v);
    }
    return out;
  }
  return value;
}

function tokenHash(token: string): string {
  return token ? createHash('sha256').update(token).digest('hex').slice(0, 12) : 'none';
}

async function parseMessage(msg: WeixinMessage): Promise<{ text: string; refText: string; mediaItems: DownloadedMedia[] }> {
  const parts: string[] = [];
  let refText = '';
  const mediaItems: DownloadedMedia[] = [];
  
  for (const item of msg.item_list) {
    if (item.type === 1 && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === 2 && item.image_item) {
      try {
        const media = await downloadImage(item.image_item);
        mediaItems.push(media);
        parts.push(`[图片: ${media.fileName}]`);
      } catch (err) {
        log.error('[parseMessage] 下载图片失败:', err);
        parts.push('[图片: 下载失败]');
      }
    } else if (item.type === 3 && item.voice_item?.text) {
      parts.push(item.voice_item.text); // voice-to-text transcription
    } else if (item.type === 4 && item.file_item) {
      try {
        const media = await downloadFile(item.file_item);
        mediaItems.push(media);
        parts.push(`[文件: ${media.fileName}]`);
      } catch (err) {
        log.error('[parseMessage] 下载文件失败:', err);
        parts.push('[文件: 下载失败]');
      }
    } else if (item.type === 5 && item.video_item) {
      try {
        const media = await downloadVideo(item.video_item);
        mediaItems.push(media);
        parts.push(`[视频: ${media.fileName}]`);
      } catch (err) {
        log.error('[parseMessage] 下载视频失败:', err);
        parts.push('[视频: 下载失败]');
      }
    }
    // Extract quoted message content (WeChat 引用消息)
    const ref = item.ref_msg;
    if (ref) {
      const refItem = ref.message_item;
      if (refItem?.text_item?.text) refText = refItem.text_item.text;
      else if (refItem?.voice_item?.text) refText = refItem.voice_item.text;
      else if (ref.title) refText = ref.title;
      log.debug(`[parseMessage] ref_msg extracted=${JSON.stringify(refText.substring(0, 80))}`);
    }
  }
  // WeChat embeds quoted content inline as "[引用]:\n<content>" — strip the prefix
  const text = parts.join('\n').trim().replace(/^\[引用\]:\n?/, '');
  return { text, refText, mediaItems };
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try breaking at paragraph, then line, then space
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = remaining.lastIndexOf(' ', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;

    chunks.push(remaining.substring(0, idx));
    remaining = remaining.substring(idx).trimStart();
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
