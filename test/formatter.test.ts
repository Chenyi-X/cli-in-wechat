import test from 'node:test';
import assert from 'node:assert/strict';

import { cacheHitRate, formatResponse, formatTokens } from '../src/bridge/formatter.js';

test('formatTokens renders compact token counts', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(19648), '19.6k');
  assert.equal(formatTokens(2_400_000), '2.4M');
});

test('cacheHitRate = cacheRead / (cacheRead + cacheWrite + input)', () => {
  // 62% cache hit on a run that also wrote fresh cache (6200/10000).
  assert.equal(
    cacheHitRate({ inputTokens: 1800, cacheReadTokens: 6200, cacheWriteTokens: 2000 }),
    62,
  );
  // Fresh session, nothing cached yet: 0% (honest — cache writes are billed).
  assert.equal(cacheHitRate({ inputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 2000 }), 0);
  // All-cache-hit edge: 100%.
  assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 9000, cacheWriteTokens: 0 }), 100);
  // Nothing sent at all → unknown.
  assert.equal(cacheHitRate({}), null);
});

test('formatResponse without usage keeps the legacy footer untouched', () => {
  assert.equal(formatResponse('ok', { tool: 'Pi', duration: 5000 }), 'ok\n\n— Pi | 5.0s');
  assert.equal(formatResponse('plain'), 'plain');
});

test('formatResponse splits per-run usage into labelled Chinese footer lines', () => {
  const out = formatResponse('done', {
    tool: 'Pi',
    duration: 3200,
    usage: { inputTokens: 4744, outputTokens: 73, cacheReadTokens: 19648, cacheWriteTokens: 0 },
  });
  // 19648 / (19648 + 0 + 4744) = 81%
  assert.equal(
    out,
    'done\n\n— Pi | 3.2s\n本轮 token：输入 4.7k · 输出 73\n本轮缓存命中：81%',
  );
});

test('formatResponse omits the usage line for all-zero usage', () => {
  const out = formatResponse('x', { usage: { inputTokens: 0, outputTokens: 0 } });
  assert.equal(out, 'x');
});
