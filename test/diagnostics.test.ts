import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeliveryDiagnostics, redactDiagnostic } from '../src/ilink/diagnostics.js';

test('diagnostics persist event names and redact tokens, URLs, and large bodies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-v2-diagnostics-'));
  const filePath = join(dir, 'delivery.jsonl');
  const diagnostics = new DeliveryDiagnostics(filePath, { maxTextBytes: 80 });

  diagnostics.record({
    event: 'request',
    userId: 'user-secret-123456',
    contextToken: 'context-token-secret',
    url: 'https://example.test/send?signature=secret',
    text: 'x'.repeat(200),
  });

  const line = readFileSync(filePath, 'utf8').trim();
  const parsed = JSON.parse(line) as any;
  assert.equal(parsed.event, 'request');
  assert.equal(parsed.contextToken, '***');
  assert.equal(parsed.url, '***');
  assert.equal(parsed.userId, 'user-sec...');
  assert.ok(parsed.text.endsWith('...'));
  assert.ok(!line.includes('context-token-secret'));
  assert.ok(!line.includes('signature=secret'));
});

test('redactDiagnostic preserves structured delivery counters', () => {
  const output = redactDiagnostic({
    event: 'plan',
    sentItems: 7,
    remainingItems: 3,
    body: { aes_key: 'secret', count: 2 },
  }) as any;

  assert.equal(output.sentItems, 7);
  assert.equal(output.remainingItems, 3);
  assert.equal(output.body.aes_key, '***');
  assert.equal(output.body.count, 2);
});
