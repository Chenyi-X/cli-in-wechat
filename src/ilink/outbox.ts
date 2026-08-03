import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWrite } from '../config.js';

export type OutboxPriority = 'final' | 'control' | 'media' | 'intermediate' | 'activity';

export interface OutboxTextInput {
  accountId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  priority: OutboxPriority;
  text: string;
  itemId?: string;
  createdAt?: number;
  ttlMs?: number;
}

export interface OutboxTextItem {
  schemaVersion: 1;
  itemId: string;
  clientId: string;
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
}

interface PersistedOutbox {
  schemaVersion: 1;
  items: OutboxTextItem[];
}

export interface OutboxOptions {
  defaultTtlMs?: number;
  maxItemsPerUser?: number;
  maxBytesPerUser?: number;
  now?: () => number;
}

const PRIORITY_RANK: Record<OutboxPriority, number> = {
  final: 0,
  control: 1,
  media: 2,
  intermediate: 3,
  activity: 4,
};

export class OutboxCapacityError extends Error {
  constructor(message = 'outbox capacity exceeded') {
    super(message);
    this.name = 'OutboxCapacityError';
  }
}

export class OutboxStore {
  private readonly items = new Map<string, OutboxTextItem>();
  private readonly defaultTtlMs: number;
  private readonly maxItemsPerUser: number;
  private readonly maxBytesPerUser: number;
  private readonly now: () => number;

  constructor(private readonly filePath: string, options: OutboxOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 7 * 24 * 60 * 60_000;
    this.maxItemsPerUser = options.maxItemsPerUser ?? 500;
    this.maxBytesPerUser = options.maxBytesPerUser ?? 1_000_000;
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(filePath), { recursive: true });
    this.load();
    this.pruneExpired();
  }

  enqueueText(input: OutboxTextInput): OutboxTextItem {
    this.pruneExpired();
    if (input.itemId) {
      const existing = this.items.get(input.itemId);
      if (existing) return existing;
    }

    const bytes = Buffer.byteLength(input.text, 'utf8');
    const userItems = this.forUser(input.accountId, input.userId);
    const userBytes = userItems.reduce((sum, item) => sum + item.bytes, 0);
    if (userItems.length >= this.maxItemsPerUser || userBytes + bytes > this.maxBytesPerUser) {
      throw new OutboxCapacityError();
    }

    const createdAt = input.createdAt ?? this.now();
    const item: OutboxTextItem = {
      schemaVersion: 1,
      itemId: input.itemId ?? randomUUID(),
      clientId: randomUUID(),
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
    };
    this.items.set(item.itemId, item);
    this.persist();
    return item;
  }

  list(userId?: string, accountId?: string): OutboxTextItem[] {
    this.pruneExpired();
    return [...this.items.values()]
      .filter((item) => (userId === undefined || item.userId === userId)
        && (accountId === undefined || item.accountId === accountId))
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        || a.createdAt - b.createdAt
        || a.itemId.localeCompare(b.itemId));
  }

  get(itemId: string): OutboxTextItem | undefined {
    this.pruneExpired();
    return this.items.get(itemId);
  }

  ack(itemId: string): boolean {
    if (!this.items.delete(itemId)) return false;
    this.persist();
    return true;
  }

  supersedeIntermediate(accountId: string, userId: string, generation: number): number {
    let removed = 0;
    for (const [itemId, item] of this.items) {
      if (item.accountId !== accountId || item.userId !== userId || item.generation !== generation) continue;
      if (item.priority !== 'intermediate' && item.priority !== 'activity') continue;
      this.items.delete(itemId);
      removed += 1;
    }
    if (removed > 0) this.persist();
    return removed;
  }

  private forUser(accountId: string, userId: string): OutboxTextItem[] {
    return [...this.items.values()].filter((item) => item.accountId === accountId && item.userId === userId);
  }

  private pruneExpired(): void {
    const now = this.now();
    let changed = false;
    for (const [itemId, item] of this.items) {
      if (item.expiresAt <= now) {
        this.items.delete(itemId);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedOutbox;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.items)) return;
      for (const item of parsed.items) {
        if (item.schemaVersion === 1 && item.kind === 'text' && item.itemId && item.clientId) {
          this.items.set(item.itemId, item);
        }
      }
    } catch {
      // A corrupt queue must not stop polling; the next enqueue rewrites a valid file.
    }
  }

  private persist(): void {
    const payload: PersistedOutbox = { schemaVersion: 1, items: [...this.items.values()] };
    atomicWrite(this.filePath, JSON.stringify(payload, null, 2));
  }
}
