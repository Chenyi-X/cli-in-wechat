import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWrite } from '../config.js';

export interface QuotaLimits {
  maxItemsPerWindow: number;
}

export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  maxItemsPerWindow: 10,
};

interface UserQuotaState {
  accountId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  tokenFingerprint?: string;
  seenInboundIds: string[];
  sentItems: number;
  sentBytes: number;
  confirmedItemIds: string[];
  rateBackoffUntil: number;
}

interface PersistedQuota {
  schemaVersion: 1;
  users: Record<string, UserQuotaState>;
}

export interface InboundResult {
  duplicate: boolean;
  generation: number;
  tokenVersion: number;
  remainingItems: number;
}

export interface QuotaSnapshot {
  accountId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  sentItems: number;
  sentBytes: number;
  remainingItems: number;
  rateBackoffUntil: number;
}

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function emptyState(accountId: string, userId: string): UserQuotaState {
  return {
    accountId,
    userId,
    generation: 0,
    tokenVersion: 0,
    seenInboundIds: [],
    sentItems: 0,
    sentBytes: 0,
    confirmedItemIds: [],
    rateBackoffUntil: 0,
  };
}

export class QuotaManager {
  private readonly users = new Map<string, UserQuotaState>();
  private readonly limits: QuotaLimits;

  constructor(
    private readonly filePath: string,
    private readonly accountId: string,
    limits: Partial<QuotaLimits> = {},
  ) {
    this.limits = {
      ...DEFAULT_QUOTA_LIMITS,
      ...limits,
      maxItemsPerWindow: Math.max(1, Math.floor(limits.maxItemsPerWindow ?? DEFAULT_QUOTA_LIMITS.maxItemsPerWindow)),
    };
    mkdirSync(dirname(filePath), { recursive: true });
    this.load();
  }

  recordInbound(userId: string, messageId: string | number, contextToken: string): InboundResult {
    const state = this.getState(userId);
    const id = String(messageId);
    if (state.seenInboundIds.includes(id)) {
      return this.inboundResult(state, true);
    }

    state.seenInboundIds.push(id);
    if (state.seenInboundIds.length > 1000) state.seenInboundIds.shift();
    state.generation += 1;
    state.sentItems = 0;
    state.sentBytes = 0;
    state.confirmedItemIds = [];
    if (contextToken) {
      const fingerprint = tokenFingerprint(contextToken);
      if (state.tokenFingerprint !== fingerprint) {
        state.tokenFingerprint = fingerprint;
        state.tokenVersion += 1;
      }
    }
    this.persist();
    return this.inboundResult(state, false);
  }

  confirmSend(userId: string, itemId: string, bytes = 0): boolean {
    const state = this.getState(userId);
    const confirmationKey = `${state.generation}:${itemId}`;
    if (state.generation === 0 || state.confirmedItemIds.includes(confirmationKey)) return false;
    if (state.sentItems >= this.limits.maxItemsPerWindow) return false;
    state.confirmedItemIds.push(confirmationKey);
    state.sentItems += 1;
    state.sentBytes += Math.max(0, bytes);
    this.persist();
    return true;
  }

  remaining(userId: string): number {
    const state = this.users.get(userId);
    if (!state || state.generation === 0) return 0;
    return Math.max(0, this.limits.maxItemsPerWindow - state.sentItems);
  }

  canOpenWindow(userId: string): boolean {
    const state = this.users.get(userId);
    return Boolean(state && state.generation > 0 && Date.now() >= state.rateBackoffUntil && this.remaining(userId) > 0);
  }

  markRateBackoff(userId: string, durationMs: number): number {
    const state = this.getState(userId);
    state.rateBackoffUntil = Math.max(state.rateBackoffUntil, Date.now() + Math.max(0, durationMs));
    this.persist();
    return state.rateBackoffUntil;
  }

  clearRateBackoff(userId: string): boolean {
    const state = this.getState(userId);
    if (state.rateBackoffUntil === 0) return false;
    state.rateBackoffUntil = 0;
    this.persist();
    return true;
  }

  snapshot(userId: string): QuotaSnapshot {
    const state = this.getState(userId);
    return {
      accountId: state.accountId,
      userId: state.userId,
      generation: state.generation,
      tokenVersion: state.tokenVersion,
      sentItems: state.sentItems,
      sentBytes: state.sentBytes,
      remainingItems: this.remaining(userId),
      rateBackoffUntil: state.rateBackoffUntil,
    };
  }

  private inboundResult(state: UserQuotaState, duplicate: boolean): InboundResult {
    return {
      duplicate,
      generation: state.generation,
      tokenVersion: state.tokenVersion,
      remainingItems: this.remaining(state.userId),
    };
  }

  private getState(userId: string): UserQuotaState {
    let state = this.users.get(userId);
    if (!state) {
      state = emptyState(this.accountId, userId);
      this.users.set(userId, state);
    }
    return state;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedQuota>;
      if (!parsed.users || typeof parsed.users !== 'object') return;
      for (const [key, raw] of Object.entries(parsed.users)) {
        if (!raw || typeof raw !== 'object') continue;
        const value = raw as Partial<UserQuotaState>;
        const userId = typeof value.userId === 'string' ? value.userId : key;
        if (value.accountId && value.accountId !== this.accountId) continue;
        const state: UserQuotaState = {
          ...emptyState(this.accountId, userId),
          ...value,
          accountId: this.accountId,
          userId,
          generation: asNumber(value.generation ?? (value as any).inboundGeneration, 0),
          tokenVersion: asNumber(value.tokenVersion, 0),
          seenInboundIds: Array.isArray(value.seenInboundIds) ? value.seenInboundIds.map(String) : [],
          sentItems: asNumber(value.sentItems, 0),
          sentBytes: asNumber(value.sentBytes, 0),
          confirmedItemIds: Array.isArray(value.confirmedItemIds) ? value.confirmedItemIds.map(String) : [],
          rateBackoffUntil: asNumber(value.rateBackoffUntil, 0),
        };
        this.users.set(userId, state);
      }
    } catch {
      // A corrupt quota snapshot is non-authoritative; start conservatively.
    }
  }

  private persist(): void {
    const users: Record<string, UserQuotaState> = {};
    for (const [userId, state] of this.users) users[userId] = state;
    const payload: PersistedQuota = { schemaVersion: 1, users };
    atomicWrite(this.filePath, JSON.stringify(payload, null, 2));
  }
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
