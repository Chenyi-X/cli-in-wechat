export type DeliveryPriority = 'final' | 'control' | 'media' | 'intermediate' | 'activity';

export interface DeliveryItem {
  itemId: string;
  text: string;
  priority: DeliveryPriority;
  bytes: number;
  continuationNoticeAttached?: boolean;
}

export interface DeliveryWindow<T extends DeliveryItem = DeliveryItem> {
  items: T[];
  remainingItems: number;
  needsContinuation: boolean;
}

export interface DeliveryPlanOptions {
  sentItems: number;
  maxItems: number;
  maxBytes?: number;
  continuationNotice: string;
}

const PRIORITY_RANK: Record<DeliveryPriority, number> = {
  final: 0,
  control: 1,
  media: 2,
  intermediate: 3,
  activity: 4,
};

/**
 * Select one inbound delivery window without mutating the queue. The caller
 * persists the selected items before sending and removes them only after an
 * acknowledged response.
 */
export function planDeliveryWindow<T extends DeliveryItem>(
  items: readonly T[],
  options: DeliveryPlanOptions,
): DeliveryWindow<T> {
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => PRIORITY_RANK[a.item.priority] - PRIORITY_RANK[b.item.priority] || a.index - b.index)
    .map(({ item }) => item);

  const available = Math.max(0, Math.floor(options.maxItems) - Math.max(0, Math.floor(options.sentItems)));
  const count = Math.min(available, ordered.length);
  const selected = ordered.slice(0, count).map((item) => ({ ...item }));
  const remainingItems = ordered.length - selected.length;
  const needsContinuation = remainingItems > 0;

  if (needsContinuation && selected.length > 0) {
    const last = selected[selected.length - 1];
    if (last.continuationNoticeAttached) return { items: selected, remainingItems, needsContinuation };
    const suffix = `\n\n${options.continuationNotice}`;
    const text = `${last.text}${suffix}`;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (options.maxBytes !== undefined && bytes > options.maxBytes) {
      throw new RangeError(`continuation notice exceeds maxBytes for ${last.itemId}`);
    }
    selected[selected.length - 1] = { ...last, text, bytes, continuationNoticeAttached: true };
  }

  return { items: selected, remainingItems, needsContinuation };
}
