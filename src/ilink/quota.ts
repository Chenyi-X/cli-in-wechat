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
}

export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  // Local safety defaults, not claims about an official WeChat quota.
  maxItems: 100,
  maxBytes: 200_000,
  finalReserveItems: 1,
  finalReserveBytes: 2_000,
};

interface ReservationRecord {
  userKey: string;
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
  sentItems: number;
  sentBytes: number;
  reservedItems: number;
  reservedBytes: number;
  reservations: Record<string, ReservationRecord>;
  rateBackoffUntil: number;
  rateBackoffGeneration: number;
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
  | { allowed: false; reason: 'final-reserved' | 'budget-exhausted' }
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
    sentItems: 0,
    sentBytes: 0,
    reservedItems: 0,
    reservedBytes: 0,
    reservations: {},
    rateBackoffUntil: 0,
    rateBackoffGeneration: 0,
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
    this.limits = { ...DEFAULT_QUOTA_LIMITS, ...limits };
    mkdirSync(dirname(filePath), { recursive: true });
    this.load();
  }

  recordInbound(userId: string, messageId: string, contextToken: string): InboundResult {
    const state = this.getState(userId);
    if (state.seenInboundIds.includes(messageId)) {
      return {
        duplicate: true,
        inboundGeneration: state.inboundGeneration,
        tokenVersion: state.tokenVersion,
      };
    }

    state.seenInboundIds.push(messageId);
    if (state.seenInboundIds.length > 1_000) state.seenInboundIds.shift();
    state.inboundGeneration += 1;
    state.rateBackoffUntil = 0;
    state.rateBackoffGeneration = state.inboundGeneration;

    if (contextToken) {
      const nextFingerprint = fingerprint(contextToken);
      if (state.tokenFingerprint !== nextFingerprint) {
        state.tokenFingerprint = nextFingerprint;
        state.tokenVersion += 1;
      }
    }

    this.persist();
    return {
      duplicate: false,
      inboundGeneration: state.inboundGeneration,
      tokenVersion: state.tokenVersion,
    };
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
    this.persist();
  }

  clearRateBackoff(userId: string): void {
    const state = this.getState(userId);
    if (state.rateBackoffUntil === 0 && state.rateBackoffGeneration === state.inboundGeneration) return;
    state.rateBackoffUntil = 0;
    state.rateBackoffGeneration = state.inboundGeneration;
    this.persist();
  }

  getRateBackoff(userId: string): { until: number; generation: number } {
    const state = this.getState(userId);
    return {
      until: state.rateBackoffUntil,
      generation: state.rateBackoffGeneration,
    };
  }

  reserve(userId: string, bytes: number, priority: QuotaPriority, context?: QuotaContext): ReserveResult {
    if (!Number.isInteger(bytes) || bytes < 0) throw new RangeError('bytes must be a non-negative integer');

    const state = this.getState(userId);
    const maxItems = priority === 'final'
      ? this.limits.maxItems
      : Math.max(0, this.limits.maxItems - this.limits.finalReserveItems);
    const maxBytes = priority === 'final'
      ? this.limits.maxBytes
      : Math.max(0, this.limits.maxBytes - this.limits.finalReserveBytes);
    const itemsAvailable = state.sentItems + state.reservedItems + 1 <= maxItems;
    const bytesAvailable = state.sentBytes + state.reservedBytes + bytes <= maxBytes;

    if (!itemsAvailable || !bytesAvailable) {
      const overallItemsAvailable = state.sentItems + state.reservedItems + 1 <= this.limits.maxItems;
      const overallBytesAvailable = state.sentBytes + state.reservedBytes + bytes <= this.limits.maxBytes;
      return {
        allowed: false,
        reason: priority !== 'final' && overallItemsAvailable && overallBytesAvailable
          ? 'final-reserved'
          : 'budget-exhausted',
      };
    }

    const reservationId = randomUUID();
    state.reservations[reservationId] = { userKey: this.key(userId), items: 1, bytes };
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
        state.rateBackoffUntil = Number.isFinite(state.rateBackoffUntil) ? state.rateBackoffUntil : 0;
        state.rateBackoffGeneration = Number.isInteger(state.rateBackoffGeneration)
          ? state.rateBackoffGeneration
          : state.inboundGeneration;
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
