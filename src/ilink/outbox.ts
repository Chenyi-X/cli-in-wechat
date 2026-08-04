import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWrite } from '../config.js';

export type OutboxPriority = 'final' | 'control' | 'media' | 'intermediate' | 'activity';
export type OutboxState = 'pending' | 'permanent-failure';

export interface OutboxError {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  httpStatus?: number;
}

export interface OutboxItem {
  schemaVersion: 2;
  itemId: string;
  clientId: string;
  sequence: number;
  kind: 'text';
  accountId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  priority: OutboxPriority;
  text: string;
  bytes: number;
  createdAt: number;
  expiresAt: number;
  state: OutboxState;
  recoveryRequired?: boolean;
  terminalError?: OutboxError;
}

export interface OutboxInput {
  accountId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  priority: OutboxPriority;
  text: string;
  itemId?: string;
  clientId?: string;
  createdAt?: number;
  ttlMs?: number;
}

export interface OutboxOptions {
  defaultTtlMs?: number;
  maxItemsPerUser?: number;
  maxBytesPerUser?: number;
  now?: () => number;
}

export class OutboxCapacityError extends Error {
  constructor(message = 'outbox capacity exceeded; durable final content was preserved') {
    super(message);
    this.name = 'OutboxCapacityError';
  }
}

export class OutboxCorruptionError extends Error {
  constructor(public readonly filePath: string) {
    super(`outbox is corrupt and has no recoverable snapshot: ${filePath}`);
    this.name = 'OutboxCorruptionError';
  }
}

interface PersistedOutbox {
  schemaVersion: 2;
  nextSequence: number;
  items: OutboxItem[];
}

interface LegacySnapshot {
  schemaVersion?: number;
  nextSequence?: number;
  items?: unknown[];
}

const PRIORITY_RANK: Record<OutboxPriority, number> = {
  final: 0,
  control: 1,
  media: 2,
  intermediate: 3,
  activity: 4,
};

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;

export class OutboxStore {
  private readonly items = new Map<string, OutboxItem>();
  private readonly backupPath: string;
  private readonly defaultTtlMs: number;
  private readonly maxItemsPerUser: number;
  private readonly maxBytesPerUser: number;
  private readonly now: () => number;
  private nextSequence = 1;

  constructor(private readonly filePath: string, options: OutboxOptions = {}) {
    this.backupPath = `${filePath}.bak`;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.maxItemsPerUser = options.maxItemsPerUser ?? 500;
    this.maxBytesPerUser = options.maxBytesPerUser ?? 1_000_000;
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(filePath), { recursive: true });
    this.load();
    this.pruneExpired();
  }

  enqueue(input: OutboxInput): OutboxItem {
    this.pruneExpired();
    if (input.itemId) {
      const existing = this.items.get(input.itemId);
      if (existing) return existing;
    }

    const nextItems = new Map(this.items);
    if (input.priority === 'final') {
      this.removeSuperseded(nextItems, input.accountId, input.userId, input.generation);
    }

    const bytes = Buffer.byteLength(input.text, 'utf8');
    const userItems = [...nextItems.values()].filter((item) =>
      item.accountId === input.accountId && item.userId === input.userId);
    const evictions = this.ensureCapacity(userItems, input.priority, bytes);
    for (const eviction of evictions) nextItems.delete(eviction.itemId);

    const createdAt = input.createdAt ?? this.now();
    const item: OutboxItem = {
      schemaVersion: 2,
      itemId: input.itemId ?? randomUUID(),
      clientId: input.clientId ?? randomUUID(),
      sequence: this.nextSequence++,
      kind: 'text',
      accountId: input.accountId,
      userId: input.userId,
      generation: input.generation,
      tokenVersion: input.tokenVersion,
      priority: input.priority,
      text: input.text,
      bytes,
      createdAt,
      expiresAt: createdAt + (input.ttlMs ?? this.defaultTtlMs),
      state: 'pending',
    };
    nextItems.set(item.itemId, item);
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
    return item;
  }

  list(userId?: string, accountId?: string): OutboxItem[] {
    this.pruneExpired();
    return [...this.items.values()]
      .filter((item) => (userId === undefined || item.userId === userId)
        && (accountId === undefined || item.accountId === accountId))
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        || a.sequence - b.sequence
        || a.itemId.localeCompare(b.itemId));
  }

  listPending(userId?: string, accountId?: string): OutboxItem[] {
    return this.list(userId, accountId).filter((item) => item.state === 'pending');
  }

  get(itemId: string): OutboxItem | undefined {
    this.pruneExpired();
    return this.items.get(itemId);
  }

  ack(itemId: string): boolean {
    if (!this.items.has(itemId)) return false;
    const nextItems = new Map(this.items);
    nextItems.delete(itemId);
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
    return true;
  }

  markAmbiguous(itemId: string, error: OutboxError): boolean {
    const item = this.items.get(itemId);
    if (!item || item.state !== 'pending') return false;
    const nextItems = new Map(this.items);
    nextItems.set(itemId, { ...item, recoveryRequired: true, terminalError: error });
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
    return true;
  }

  markPermanentFailure(itemId: string, error: OutboxError): boolean {
    const item = this.items.get(itemId);
    if (!item || item.state === 'permanent-failure') return false;
    const nextItems = new Map(this.items);
    nextItems.set(itemId, {
      ...item,
      state: 'permanent-failure',
      recoveryRequired: false,
      terminalError: error,
    });
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
    return true;
  }

  clearRecoveryRequired(itemId: string): boolean {
    const item = this.items.get(itemId);
    if (!item?.recoveryRequired) return false;
    const nextItems = new Map(this.items);
    nextItems.set(itemId, { ...item, recoveryRequired: undefined });
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
    return true;
  }

  supersedeIntermediate(accountId: string, userId: string, generation: number): number {
    const nextItems = new Map(this.items);
    const removed = this.removeSuperseded(nextItems, accountId, userId, generation);
    if (removed > 0) {
      this.persistState(nextItems, this.nextSequence);
      this.publish(nextItems, this.nextSequence);
    }
    return removed;
  }

  private ensureCapacity(userItems: OutboxItem[], incomingPriority: OutboxPriority, incomingBytes: number): OutboxItem[] {
    let count = userItems.length + 1;
    let bytes = userItems.reduce((sum, item) => sum + item.bytes, 0) + incomingBytes;
    if (count <= this.maxItemsPerUser && bytes <= this.maxBytesPerUser) return [];

    const candidates = userItems
      .filter((item) => item.state === 'permanent-failure' || PRIORITY_RANK[item.priority] > PRIORITY_RANK[incomingPriority])
      .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || b.sequence - a.sequence);
    const evictions: OutboxItem[] = [];
    for (const candidate of candidates) {
      if (count <= this.maxItemsPerUser && bytes <= this.maxBytesPerUser) return evictions;
      evictions.push(candidate);
      count -= 1;
      bytes -= candidate.bytes;
    }
    if (count > this.maxItemsPerUser || bytes > this.maxBytesPerUser) {
      throw new OutboxCapacityError();
    }
    return evictions;
  }

  private removeSuperseded(target: Map<string, OutboxItem>, accountId: string, userId: string, generation: number): number {
    let removed = 0;
    for (const [itemId, item] of target) {
      if (item.accountId !== accountId || item.userId !== userId || item.generation !== generation) continue;
      if (item.priority !== 'activity' && item.priority !== 'intermediate') continue;
      target.delete(itemId);
      removed += 1;
    }
    return removed;
  }

  private pruneExpired(): void {
    const nextItems = new Map(this.items);
    let changed = false;
    for (const [itemId, item] of nextItems) {
      if (item.state === 'pending' && item.expiresAt <= this.now()) {
        nextItems.set(itemId, {
          ...item,
          state: 'permanent-failure',
          terminalError: { errmsg: 'outbox item expired before delivery' },
        });
        changed = true;
      }
    }
    if (changed) {
      this.persistState(nextItems, this.nextSequence);
      this.publish(nextItems, this.nextSequence);
    }
  }

  private load(): void {
    const primary = this.readSnapshot(this.filePath);
    if (primary) {
      this.loadSnapshot(primary);
      if (primary.schemaVersion !== 2) this.persist();
      return;
    }
    const backup = this.readSnapshot(this.backupPath);
    if (backup) {
      this.loadSnapshot(backup);
      this.persist();
      return;
    }
    if (existsSync(this.filePath) || existsSync(this.backupPath)) {
      throw new OutboxCorruptionError(this.filePath);
    }
  }

  private readSnapshot(filePath: string): LegacySnapshot | undefined {
    if (!existsSync(filePath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as LegacySnapshot;
      if (!Array.isArray(parsed.items)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private loadSnapshot(snapshot: LegacySnapshot): void {
    let maxSequence = 0;
    for (const raw of snapshot.items ?? []) {
      if (!raw || typeof raw !== 'object') continue;
      const value = raw as Partial<OutboxItem>;
      if (typeof value.text !== 'string') continue;
      const priority = value.priority && PRIORITY_RANK[value.priority] !== undefined
        ? value.priority
        : 'final';
      const sequence = asFiniteNumber(value.sequence, maxSequence + 1);
      const createdAt = asFiniteNumber(value.createdAt, this.now());
      const item: OutboxItem = {
        schemaVersion: 2,
        itemId: value.itemId || randomUUID(),
        clientId: value.clientId || randomUUID(),
        sequence,
        kind: 'text',
        accountId: value.accountId || '',
        userId: value.userId || '',
        generation: asFiniteNumber(value.generation, 0),
        tokenVersion: asFiniteNumber(value.tokenVersion, 0),
        priority,
        text: value.text,
        bytes: Buffer.byteLength(value.text, 'utf8'),
        createdAt,
        expiresAt: asFiniteNumber(value.expiresAt, createdAt + this.defaultTtlMs),
        state: value.state === 'permanent-failure' ? 'permanent-failure' : 'pending',
        ...(value.recoveryRequired ? { recoveryRequired: true } : {}),
        ...(value.terminalError ? { terminalError: value.terminalError } : {}),
      };
      if (this.items.has(item.itemId)) continue;
      this.items.set(item.itemId, item);
      maxSequence = Math.max(maxSequence, sequence);
    }
    this.nextSequence = Math.max(Number.isInteger(snapshot.nextSequence) ? snapshot.nextSequence! : 1, maxSequence + 1);
  }

  private persistState(items: Map<string, OutboxItem>, nextSequence: number): void {
    const payload: PersistedOutbox = { schemaVersion: 2, nextSequence, items: [...items.values()] };
    const encoded = JSON.stringify(payload, null, 2);
    atomicWrite(this.backupPath, encoded);
    atomicWrite(this.filePath, encoded);
  }

  private persist(): void {
    this.persistState(this.items, this.nextSequence);
  }

  private publish(items: Map<string, OutboxItem>, nextSequence: number): void {
    this.items.clear();
    for (const [itemId, item] of items) this.items.set(itemId, item);
    this.nextSequence = nextSequence;
  }
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
