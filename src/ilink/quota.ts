import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWrite } from '../config.js';

export type QuotaPriority = 'final' | 'control' | 'media' | 'intermediate' | 'activity';

export interface QuotaLimits {
  maxItems: number;
  maxBytes: number;
  finalReserveItems: number;
  finalReserveBytes: number;
  maxItemsPerToken: number;
  maxIntermediateItemsPerToken: number;
  finalReserveItemsPerToken: number;
}

export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  // Local safety defaults, not claims about an official WeChat quota.
  maxItems: 100,
  maxBytes: 200_000,
  finalReserveItems: 1,
  finalReserveBytes: 2_000,
  // Conservative local guards based on observed behavior. These are not
  // claims about an official iLink quota and should remain configurable.
  maxItemsPerToken: 10,
  maxIntermediateItemsPerToken: 9,
  finalReserveItemsPerToken: 3,
};

interface ReservationRecord {
  userKey: string;
  tokenVersion: number;
  items: number;
  bytes: number;
}

interface UserQuotaState {
  accountId: string;
  userId: string;
  inboundGeneration: number;
  tokenVersion: number;
  tokenFingerprint?: string;
  seenInboundIds: string[];
  pendingInboundIds: string[];
  sentItems: number;
  sentBytes: number;
  reservedItems: number;
  reservedBytes: number;
  reservations: Record<string, ReservationRecord>;
  tokenSentItems: number;
  tokenSentBytes: number;
  tokenBudgetNoticeVersion?: number;
  rateBackoffUntil: number;
  rateBackoffGeneration: number;
  rateBackoffTokenVersion?: number;
}

interface PersistedQuotaState {
  schemaVersion: 1;
  users: Record<string, UserQuotaState>;
}

export interface InboundResult {
  duplicate: boolean;
  inboundGeneration: number;
  tokenVersion: number;
}

export interface QuotaSnapshot {
  accountId: string;
  userId: string;
  inboundGeneration: number;
  tokenVersion: number;
  sentItems: number;
  sentBytes: number;
  reservedItems: number;
  reservedBytes: number;
}

export interface TokenBudgetSnapshot {
  maxItems: number;
  sentItems: number;
  reservedItems: number;
  remainingItems: number;
}

export interface QuotaReservation {
  reservationId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  items: number;
  bytes: number;
  priority: QuotaPriority;
}

export interface QuotaContext {
  generation: number;
  tokenVersion: number;
}

export type ReserveResult =
  | { allowed: false; reason: 'final-reserved' | 'budget-exhausted' | 'item-too-large' | 'intermediate-budget' | 'token-budget-exhausted' }
  | { allowed: true; reservation: QuotaReservation };

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function emptyState(accountId: string, userId: string): UserQuotaState {
  return {
    accountId,
    userId,
    inboundGeneration: 0,
    tokenVersion: 0,
    seenInboundIds: [],
    pendingInboundIds: [],
    sentItems: 0,
    sentBytes: 0,
    reservedItems: 0,
    reservedBytes: 0,
    reservations: {},
    tokenSentItems: 0,
    tokenSentBytes: 0,
    rateBackoffUntil: 0,
    rateBackoffGeneration: 0,
  };
}

export class QuotaManager {
  private readonly users = new Map<string, UserQuotaState>();
  private readonly activeInboundIds = new Set<string>();
  private readonly limits: QuotaLimits;

  constructor(
    private readonly filePath: string,
    private readonly accountId: string,
    limits: Partial<QuotaLimits> = {},
  ) {
    this.limits = { ...DEFAULT_QUOTA_LIMITS, ...limits };
    mkdirSync(dirname(filePath), { recursive: true });
    this.load();
  }

  recordInbound(userId: string, messageId: string, contextToken: string): InboundResult {
    const state = this.getState(userId);
    const inboundKey = this.inboundKey(userId, messageId);
    const previousTokenVersion = state.tokenVersion;
    if (state.seenInboundIds.includes(messageId) || this.activeInboundIds.has(inboundKey)) {
      return {
        duplicate: true,
        inboundGeneration: state.inboundGeneration,
        tokenVersion: state.tokenVersion,
      };
    }

    const isRetry = state.pendingInboundIds.includes(messageId);
    if (!isRetry) {
      state.pendingInboundIds.push(messageId);
      state.inboundGeneration += 1;
    }
    this.activeInboundIds.add(inboundKey);
    if (isRetry) {
      return {
        duplicate: false,
        inboundGeneration: state.inboundGeneration,
        tokenVersion: state.tokenVersion,
      };
    }

    if (state.rateBackoffUntil === 0) {
      state.rateBackoffGeneration = state.inboundGeneration;
    }

    if (contextToken) {
      const nextFingerprint = fingerprint(contextToken);
      if (state.tokenFingerprint !== nextFingerprint) {
        state.tokenFingerprint = nextFingerprint;
        state.tokenVersion += 1;
        state.tokenSentItems = 0;
        state.tokenSentBytes = 0;
        state.tokenBudgetNoticeVersion = undefined;
      }
    }

    const tokenChanged = state.tokenVersion > previousTokenVersion;
    const blockedTokenChanged = state.rateBackoffTokenVersion === undefined
      ? tokenChanged
      : state.tokenVersion > state.rateBackoffTokenVersion;
    if (state.rateBackoffUntil !== 0 && blockedTokenChanged) {
      state.rateBackoffUntil = 0;
      state.rateBackoffGeneration = state.inboundGeneration;
      state.rateBackoffTokenVersion = undefined;
    }

    this.persist();
    return {
      duplicate: false,
      inboundGeneration: state.inboundGeneration,
      tokenVersion: state.tokenVersion,
    };
  }

  completeInbound(userId: string, messageId: string): boolean {
    const state = this.getState(userId);
    const inboundKey = this.inboundKey(userId, messageId);
    const pendingIndex = state.pendingInboundIds.indexOf(messageId);
    if (pendingIndex < 0 && !this.activeInboundIds.has(inboundKey)) return false;

    this.activeInboundIds.delete(inboundKey);
    if (pendingIndex >= 0) state.pendingInboundIds.splice(pendingIndex, 1);
    if (!state.seenInboundIds.includes(messageId)) {
      state.seenInboundIds.push(messageId);
      if (state.seenInboundIds.length > 1_000) state.seenInboundIds.shift();
    }
    this.persist();
    return true;
  }

  abandonInbound(userId: string, messageId: string): boolean {
    return this.activeInboundIds.delete(this.inboundKey(userId, messageId));
  }

  snapshot(userId: string): QuotaSnapshot {
    const state = this.getState(userId);
    return {
      accountId: state.accountId,
      userId: state.userId,
      inboundGeneration: state.inboundGeneration,
      tokenVersion: state.tokenVersion,
      sentItems: state.sentItems,
      sentBytes: state.sentBytes,
      reservedItems: state.reservedItems,
      reservedBytes: state.reservedBytes,
    };
  }

  noteRateBackoff(userId: string, until: number): void {
    const state = this.getState(userId);
    state.rateBackoffUntil = Math.max(state.rateBackoffUntil, until);
    state.rateBackoffGeneration = state.inboundGeneration;
    state.rateBackoffTokenVersion = state.tokenVersion;
    this.persist();
  }

  clearRateBackoff(userId: string): void {
    const state = this.getState(userId);
    if (state.rateBackoffUntil === 0 && state.rateBackoffGeneration === state.inboundGeneration) return;
    state.rateBackoffUntil = 0;
    state.rateBackoffGeneration = state.inboundGeneration;
    state.rateBackoffTokenVersion = undefined;
    this.persist();
  }

  /**
   * Open one local delivery window for a real inbound recovery signal.
   *
   * The server may return the same context token for a new inbound message.
   * In that case the token-version counters cannot tell us that the user has
   * explicitly asked to resume. Keep cumulative accounting and token identity
   * intact, but allow the durable backlog one fresh guarded send window.
   */
  openInboundRecoveryWindow(userId: string): boolean {
    const state = this.getState(userId);
    const hadConsumedBudget = state.tokenSentItems > 0
      || state.tokenSentBytes > 0
      || state.tokenBudgetNoticeVersion !== undefined;
    if (!hadConsumedBudget) return false;

    state.tokenSentItems = 0;
    state.tokenSentBytes = 0;
    state.tokenBudgetNoticeVersion = undefined;
    state.rateBackoffUntil = 0;
    state.rateBackoffGeneration = state.inboundGeneration;
    state.rateBackoffTokenVersion = undefined;
    this.persist();
    return true;
  }

  getRateBackoff(userId: string): { until: number; generation: number; tokenVersion?: number } {
    const state = this.getState(userId);
    return {
      until: state.rateBackoffUntil,
      generation: state.rateBackoffGeneration,
      tokenVersion: state.rateBackoffTokenVersion,
    };
  }

  getTokenBudget(userId: string): TokenBudgetSnapshot {
    const state = this.getState(userId);
    const reservedItems = Object.values(state.reservations)
      .filter((reservation) => reservation.tokenVersion === state.tokenVersion)
      .reduce((sum, reservation) => sum + reservation.items, 0);
    return {
      maxItems: this.limits.maxItemsPerToken,
      sentItems: state.tokenSentItems,
      reservedItems,
      remainingItems: Math.max(0, this.limits.maxItemsPerToken - state.tokenSentItems - reservedItems),
    };
  }

  canReserveForPriority(userId: string, priority: QuotaPriority): boolean {
    const state = this.getState(userId);
    const reservedForToken = Object.values(state.reservations)
      .filter((reservation) => reservation.tokenVersion === state.tokenVersion)
      .reduce((sum, reservation) => sum + reservation.items, 0);
    const maxItems = priority === 'final' || priority === 'control'
      ? this.limits.maxItemsPerToken
      : priority === 'intermediate' || priority === 'activity'
        ? this.limits.maxIntermediateItemsPerToken
        : Math.max(0, this.limits.maxItemsPerToken - this.limits.finalReserveItemsPerToken);
    return state.tokenSentItems + reservedForToken + 1 <= maxItems;
  }

  claimTokenBudgetNotice(userId: string): boolean {
    const state = this.getState(userId);
    if (state.tokenBudgetNoticeVersion === state.tokenVersion) return false;
    state.tokenBudgetNoticeVersion = state.tokenVersion;
    this.persist();
    return true;
  }

  hasTokenBudgetNotice(userId: string): boolean {
    return this.getState(userId).tokenBudgetNoticeVersion === this.getState(userId).tokenVersion;
  }

  reserve(userId: string, bytes: number, priority: QuotaPriority, context?: QuotaContext): ReserveResult {
    if (!Number.isInteger(bytes) || bytes < 0) throw new RangeError('bytes must be a non-negative integer');

    const state = this.getState(userId);
    const maxItems = priority === 'final' || priority === 'control'
      ? this.limits.maxItems
      : Math.max(0, this.limits.maxItems - this.limits.finalReserveItems);
    const maxBytes = priority === 'final'
      ? this.limits.maxBytes
      : Math.max(0, this.limits.maxBytes - this.limits.finalReserveBytes);
    const tokenReservedItems = Object.values(state.reservations)
      .filter((reservation) => reservation.tokenVersion === state.tokenVersion)
      .reduce((sum, reservation) => sum + reservation.items, 0);
    const tokenReservedBytes = Object.values(state.reservations)
      .filter((reservation) => reservation.tokenVersion === state.tokenVersion)
      .reduce((sum, reservation) => sum + reservation.bytes, 0);
    const maxTokenItems = priority === 'final' || priority === 'control'
      ? this.limits.maxItemsPerToken
      : priority === 'intermediate' || priority === 'activity'
        ? this.limits.maxIntermediateItemsPerToken
        : Math.max(0, this.limits.maxItemsPerToken - this.limits.finalReserveItemsPerToken);
    const tokenItemsAvailable = state.tokenSentItems + tokenReservedItems + 1 <= maxTokenItems;
    const itemsAvailable = state.tokenSentItems + tokenReservedItems + 1 <= maxItems;
    const bytesAvailable = state.tokenSentBytes + tokenReservedBytes + bytes <= maxBytes;

    if (bytes > this.limits.maxBytes) {
      return { allowed: false, reason: 'item-too-large' };
    }

    if (!tokenItemsAvailable) {
      return {
        allowed: false,
        reason: priority === 'intermediate' || priority === 'activity'
          ? 'intermediate-budget'
          : 'token-budget-exhausted',
      };
    }

    if (!itemsAvailable || !bytesAvailable) {
      const overallItemsAvailable = state.tokenSentItems + tokenReservedItems + 1 <= this.limits.maxItems;
      const overallBytesAvailable = state.tokenSentBytes + tokenReservedBytes + bytes <= this.limits.maxBytes;
      return {
        allowed: false,
        reason: priority !== 'final' && overallItemsAvailable && overallBytesAvailable
          ? 'final-reserved'
          : 'budget-exhausted',
      };
    }

    const reservationId = randomUUID();
    state.reservations[reservationId] = {
      userKey: this.key(userId),
      tokenVersion: state.tokenVersion,
      items: 1,
      bytes,
    };
    state.reservedItems += 1;
    state.reservedBytes += bytes;
    this.persist();

    return {
      allowed: true,
      reservation: {
        reservationId,
        userId,
        generation: context?.generation ?? state.inboundGeneration,
        tokenVersion: context?.tokenVersion ?? state.tokenVersion,
        items: 1,
        bytes,
        priority,
      },
    };
  }

  commit(reservationId: string): boolean {
    const found = this.findReservation(reservationId);
    if (!found) return false;
    const { state, record } = found;
    delete state.reservations[reservationId];
    state.reservedItems -= record.items;
    state.reservedBytes -= record.bytes;
    state.sentItems += record.items;
    state.sentBytes += record.bytes;
    if (record.tokenVersion === state.tokenVersion) {
      state.tokenSentItems += record.items;
      state.tokenSentBytes += record.bytes;
    }
    this.persist();
    return true;
  }

  release(reservationId: string): boolean {
    const found = this.findReservation(reservationId);
    if (!found) return false;
    const { state, record } = found;
    delete state.reservations[reservationId];
    state.reservedItems -= record.items;
    state.reservedBytes -= record.bytes;
    this.persist();
    return true;
  }

  private key(userId: string): string {
    return `${this.accountId}\u0000${userId}`;
  }

  private inboundKey(userId: string, messageId: string): string {
    return `${this.key(userId)}\u0000${messageId}`;
  }

  private getState(userId: string): UserQuotaState {
    const key = this.key(userId);
    let state = this.users.get(key);
    if (!state) {
      state = emptyState(this.accountId, userId);
      this.users.set(key, state);
    }
    return state;
  }

  private findReservation(reservationId: string): { state: UserQuotaState; record: ReservationRecord } | null {
    for (const state of this.users.values()) {
      const record = state.reservations[reservationId];
      if (record) return { state, record };
    }
    return null;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedQuotaState;
      if (parsed.schemaVersion !== 1 || !parsed.users) return;
      for (const [key, state] of Object.entries(parsed.users)) {
        if (state.accountId !== this.accountId) continue;
        // A reservation has no durable send acknowledgement. After a crash the
        // outbox item is the source of truth, so release in-flight quota holds and
        // retry with the same stable client_id instead of permanently leaking budget.
        state.reservations = {};
        state.reservedItems = 0;
        state.reservedBytes = 0;
        state.seenInboundIds = Array.isArray(state.seenInboundIds) ? state.seenInboundIds : [];
        state.pendingInboundIds = Array.isArray(state.pendingInboundIds) ? state.pendingInboundIds : [];
        // Older quota snapshots did not persist per-token counters. Treat the
        // current token as exhausted rather than resetting its budget after a
        // restart; a genuinely new context token resets these counters below.
        state.tokenSentItems = Number.isInteger(state.tokenSentItems)
          ? state.tokenSentItems
          : this.limits.maxItemsPerToken;
        state.tokenSentBytes = Number.isInteger(state.tokenSentBytes) ? state.tokenSentBytes : 0;
        state.rateBackoffUntil = Number.isFinite(state.rateBackoffUntil) ? state.rateBackoffUntil : 0;
        state.rateBackoffGeneration = Number.isInteger(state.rateBackoffGeneration)
          ? state.rateBackoffGeneration
          : state.inboundGeneration;
        state.rateBackoffTokenVersion = Number.isInteger(state.rateBackoffTokenVersion)
          ? state.rateBackoffTokenVersion
          : state.rateBackoffUntil > 0 ? state.tokenVersion : undefined;
        this.users.set(key, state);
      }
    } catch {
      // A malformed quota file must not prevent the bridge from starting.
    }
  }

  private persist(): void {
    const users: Record<string, UserQuotaState> = {};
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedQuotaState;
        if (parsed.schemaVersion === 1 && parsed.users) {
          Object.assign(users, parsed.users);
        }
      } catch {
        // Keep the current in-memory account state if the old snapshot is corrupt.
      }
    }
    for (const [key, state] of this.users) users[key] = state;
    const payload: PersistedQuotaState = { schemaVersion: 1, users };
    atomicWrite(this.filePath, JSON.stringify(payload, null, 2));
  }
}
