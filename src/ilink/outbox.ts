import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

import { atomicWrite } from '../config.js';

export type OutboxPriority = 'final' | 'control' | 'media' | 'intermediate' | 'activity';

export interface OutboxTextInput {
  accountId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  priority: OutboxPriority;
  batchId?: string;
  text: string;
  itemId?: string;
  createdAt?: number;
  ttlMs?: number;
}

export interface OutboxTextItem {
  schemaVersion: 1;
  itemId: string;
  clientId: string;
  sequence: number;
  kind: 'text';
  accountId: string;
  userId: string;
  generation: number;
  tokenVersion: number;
  priority: OutboxPriority;
  batchId?: string;
  text: string;
  bytes: number;
  createdAt: number;
  expiresAt: number;
  state: 'pending' | 'permanent-failure';
  recoveryRequired?: boolean;
  terminalError?: {
    ret?: number;
    errcode?: number;
    errmsg?: string;
    httpStatus?: number;
  };
}

interface PersistedOutbox {
  schemaVersion: 1;
  items: OutboxTextItem[];
  nextSequence?: number;
}

export interface OutboxOptions {
  defaultTtlMs?: number;
  maxItemsPerUser?: number;
  maxBytesPerUser?: number;
  finalReserveItems?: number;
  finalReserveBytes?: number;
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

export class OutboxCorruptionError extends Error {
  constructor(public readonly filePath: string) {
    super(`outbox is corrupt and has no recoverable backup: ${filePath}`);
    this.name = 'OutboxCorruptionError';
  }
}

export class OutboxStore {
  private readonly items = new Map<string, OutboxTextItem>();
  private readonly defaultTtlMs: number;
  private readonly maxItemsPerUser: number;
  private readonly maxBytesPerUser: number;
  private readonly finalReserveItems: number;
  private readonly finalReserveBytes: number;
  private readonly now: () => number;
  private nextSequence = 1;
  private readonly backupPath: string;

  constructor(private readonly filePath: string, options: OutboxOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 7 * 24 * 60 * 60_000;
    this.maxItemsPerUser = options.maxItemsPerUser ?? 500;
    this.maxBytesPerUser = options.maxBytesPerUser ?? 1_000_000;
    this.finalReserveItems = Math.max(0, Math.floor(options.finalReserveItems ?? 1));
    this.finalReserveBytes = Math.max(0, Math.floor(options.finalReserveBytes ?? 2_000));
    this.now = options.now ?? Date.now;
    this.backupPath = `${filePath}.bak`;
    mkdirSync(dirname(filePath), { recursive: true });
    this.load();
    this.pruneExpired();
  }

  enqueueText(input: OutboxTextInput): OutboxTextItem {
    return this.enqueueTextBatch([input])[0];
  }

  enqueueTextBatch(inputs: OutboxTextInput[]): OutboxTextItem[] {
    if (inputs.length === 0) return [];
    this.pruneExpired();

    const nextItems = new Map(this.items);
    let nextSequence = this.nextSequence;
    let changed = false;
    const result: OutboxTextItem[] = [];

    for (const input of inputs) {
      if (input.itemId) {
        const existing = nextItems.get(input.itemId);
        if (existing) {
          result.push(existing);
          continue;
        }
      }

      const bytes = Buffer.byteLength(input.text, 'utf8');
      const userItems = [...nextItems.values()].filter((item) =>
        item.accountId === input.accountId && item.userId === input.userId);
      const userBytes = userItems.reduce((sum, item) => sum + item.bytes, 0);
      const evict = this.selectEvictions(userItems, input.priority, bytes, userBytes);
      for (const item of evict) nextItems.delete(item.itemId);

      const createdAt = input.createdAt ?? this.now();
      const item: OutboxTextItem = {
        schemaVersion: 1,
        itemId: input.itemId ?? randomUUID(),
        clientId: randomUUID(),
        sequence: nextSequence++,
        kind: 'text',
        accountId: input.accountId,
        userId: input.userId,
        generation: input.generation,
        tokenVersion: input.tokenVersion,
        priority: input.priority,
        batchId: input.batchId,
        text: input.text,
        bytes,
        createdAt,
        expiresAt: createdAt + (input.ttlMs ?? this.defaultTtlMs),
        state: 'pending',
      };
      nextItems.set(item.itemId, item);
      result.push(item);
      changed = true;
    }

    if (!changed) return result;
    this.persistState(nextItems, nextSequence);
    this.publish(nextItems, nextSequence);
    return result;
  }

  private selectEvictions(
    userItems: OutboxTextItem[],
    incomingPriority: OutboxPriority,
    incomingBytes: number,
    currentBytes: number,
  ): OutboxTextItem[] {
    const pendingFinalItems = userItems.filter((item) => item.state === 'pending' && item.priority === 'final');
    const pendingFinalBytes = pendingFinalItems.reduce((sum, item) => sum + item.bytes, 0);
    const reservedItems = incomingPriority === 'final'
      ? 0
      : Math.max(0, this.finalReserveItems - pendingFinalItems.length);
    const reservedBytes = incomingPriority === 'final'
      ? 0
      : Math.max(0, this.finalReserveBytes - pendingFinalBytes);
    const fits = (count: number, bytes: number) =>
      count <= Math.max(0, this.maxItemsPerUser - reservedItems)
      && bytes <= Math.max(0, this.maxBytesPerUser - reservedBytes);
    if (fits(userItems.length + 1, currentBytes + incomingBytes)) return [];

    // Preserve higher-priority durable work. A final result can evict stale
    // control/intermediate/activity items; a control notice can evict only
    // media/intermediate/activity items, and so on.
    const candidates = userItems
      .filter((item) => item.state === 'permanent-failure'
        || PRIORITY_RANK[item.priority] > PRIORITY_RANK[incomingPriority])
      .sort((a, b) => Number(a.state !== 'permanent-failure') - Number(b.state !== 'permanent-failure')
        || PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
        || b.createdAt - a.createdAt
        || b.itemId.localeCompare(a.itemId));
    const selected: OutboxTextItem[] = [];
    let count = userItems.length + 1;
    let bytes = currentBytes + incomingBytes;
    for (const candidate of candidates) {
      if (fits(count, bytes)) break;
      selected.push(candidate);
      count -= 1;
      bytes -= candidate.bytes;
    }

    if (!fits(count, bytes)) throw new OutboxCapacityError();
    return selected;
  }

  list(userId?: string, accountId?: string): OutboxTextItem[] {
    this.pruneExpired();
    return [...this.items.values()]
      .filter((item) => (userId === undefined || item.userId === userId)
        && (accountId === undefined || item.accountId === accountId))
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        || a.sequence - b.sequence
        || a.createdAt - b.createdAt
        || a.itemId.localeCompare(b.itemId));
  }

  get(itemId: string): OutboxTextItem | undefined {
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

  listPending(userId?: string, accountId?: string): OutboxTextItem[] {
    return this.list(userId, accountId).filter((item) => item.state === 'pending');
  }

  markPermanentFailure(itemId: string, error: OutboxTextItem['terminalError']): boolean {
    const item = this.items.get(itemId);
    if (!item || item.state === 'permanent-failure') return false;
    const nextItems = new Map(this.items);
    nextItems.set(itemId, { ...item, state: 'permanent-failure', terminalError: error });
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
    return true;
  }

  markRecoveryRequired(itemId: string): boolean {
    const item = this.items.get(itemId);
    if (!item || item.recoveryRequired) return false;
    const nextItems = new Map(this.items);
    nextItems.set(itemId, { ...item, recoveryRequired: true });
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
    return true;
  }

  clearRecoveryRequired(itemId: string): boolean {
    const item = this.items.get(itemId);
    if (!item || !item.recoveryRequired) return false;
    const nextItems = new Map(this.items);
    nextItems.set(itemId, { ...item, recoveryRequired: undefined });
    this.persistState(nextItems, this.nextSequence);
    this.publish(nextItems, this.nextSequence);
    return true;
  }

  requeuePermanentFailures(matches: (item: OutboxTextItem) => boolean): number {
    const nextItems = new Map(this.items);
    let changed = 0;
    for (const [itemId, item] of nextItems) {
      if (item.state !== 'permanent-failure' || !matches(item)) continue;
      nextItems.set(itemId, { ...item, state: 'pending', terminalError: undefined });
      changed += 1;
    }
    if (changed > 0) {
      this.persistState(nextItems, this.nextSequence);
      this.publish(nextItems, this.nextSequence);
    }
    return changed;
  }

  supersedeIntermediate(accountId: string, userId: string, generation: number): number {
    const nextItems = new Map(this.items);
    let removed = 0;
    for (const [itemId, item] of nextItems) {
      if (item.accountId !== accountId || item.userId !== userId || item.generation !== generation) continue;
      if (item.priority !== 'intermediate' && item.priority !== 'activity') continue;
      nextItems.delete(itemId);
      nextItems.delete(`delivery-notice:${itemId}`);
      removed += 1;
    }
    if (removed > 0) {
      this.persistState(nextItems, this.nextSequence);
      this.publish(nextItems, this.nextSequence);
    }
    return removed;
  }

  private pruneExpired(): void {
    const now = this.now();
    const nextItems = new Map(this.items);
    let changed = false;
    for (const [itemId, item] of nextItems) {
      if (item.state === 'pending' && item.expiresAt <= now) {
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
    const primaryExists = existsSync(this.filePath);
    const primary = this.readPersisted(this.filePath);
    if (primary) {
      this.loadItems(primary);
      return;
    }
    const backupExists = existsSync(this.backupPath);
    const backup = this.readPersisted(this.backupPath);
    if (backup) {
      this.loadItems(backup);
      // Reconstitute the primary from the last valid snapshot before polling.
      this.persist();
      return;
    }

    if (!primaryExists && !backupExists) return;

    if (primaryExists) this.quarantine(this.filePath);
    if (backupExists) this.quarantine(this.backupPath);
    throw new OutboxCorruptionError(this.filePath);
  }

  private readPersisted(filePath: string): PersistedOutbox | undefined {
    if (!existsSync(filePath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PersistedOutbox;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.items)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private loadItems(parsed: PersistedOutbox): void {
    let maxSequence = 0;
    for (const rawItem of parsed.items) {
      if (rawItem.schemaVersion === 1 && rawItem.kind === 'text' && rawItem.itemId && rawItem.clientId) {
        const sequence = Number.isInteger(rawItem.sequence) ? rawItem.sequence : maxSequence + 1;
        const item = {
          ...rawItem,
          sequence,
          state: rawItem.state === 'permanent-failure' ? 'permanent-failure' as const : 'pending' as const,
        };
        maxSequence = Math.max(maxSequence, sequence);
        this.items.set(item.itemId, item);
      }
    }
    this.nextSequence = Math.max(Number.isInteger(parsed.nextSequence) ? parsed.nextSequence! : 1, maxSequence + 1);
  }

  private quarantine(filePath: string): void {
    try {
      renameSync(filePath, `${filePath}.corrupt-${Date.now()}-${randomUUID()}`);
    } catch {
      // Preserve the original corruption error even if the filesystem rejects quarantine.
    }
  }

  private publish(nextItems: Map<string, OutboxTextItem>, nextSequence: number): void {
    this.items.clear();
    for (const [itemId, item] of nextItems) this.items.set(itemId, item);
    this.nextSequence = nextSequence;
  }

  private persistState(items: Map<string, OutboxTextItem>, nextSequence: number): void {
    const payload: PersistedOutbox = {
      schemaVersion: 1,
      nextSequence,
      items: [...items.values()],
    };
    const encoded = JSON.stringify(payload, null, 2);
    // Write the recoverable snapshot first. If the primary update is interrupted,
    // the previous primary or this backup remains a complete JSON document.
    atomicWrite(this.backupPath, encoded);
    atomicWrite(this.filePath, encoded);
  }

  private persist(): void {
    this.persistState(this.items, this.nextSequence);
  }
}
