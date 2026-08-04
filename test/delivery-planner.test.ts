import test from 'node:test';
import assert from 'node:assert/strict';

import { planDeliveryWindow } from '../src/ilink/delivery-planner.js';

test('plans thirteen final chunks as ten now and three later', () => {
  const items = Array.from({ length: 13 }, (_, index) => ({
    itemId: `item-${index + 1}`,
    text: `chunk-${index + 1}`,
    priority: 'final' as const,
    bytes: Buffer.byteLength(`chunk-${index + 1}`, 'utf8'),
  }));

  const first = planDeliveryWindow(items, {
    sentItems: 0,
    maxItems: 10,
    continuationNotice: '后续内容已排队，请回复“继续”续发。',
  });

  assert.deepEqual(
    first.items.map((item) => item.itemId),
    Array.from({ length: 10 }, (_, i) => `item-${i + 1}`),
  );
  assert.equal(first.items.at(-1)?.text.endsWith('后续内容已排队，请回复“继续”续发。'), true);
  assert.equal(first.remainingItems, 3);
});
