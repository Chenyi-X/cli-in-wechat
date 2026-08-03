import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeliveryDiagnostics } from '../src/ilink/diagnostics.js';

test('DeliveryDiagnostics persists redacted send evidence without message content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-diagnostics-'));
  const filePath = join(dir, 'delivery.jsonl');

  try {
    const diagnostics = new DeliveryDiagnostics(filePath, () => 1_700_000_000_000);
    diagnostics.record({
      event: 'response',
      accountId: 'account-secret',
      userId: 'user-secret',
      contextToken: 'token-secret',
      clientId: 'client-1',
      itemId: 'item-1',
      itemSequence: 7,
      bubbleSequence: 1,
      generation: 3,
      tokenVersion: 2,
      priority: 'final',
      itemCount: 1,
      jsLength: 6,
      utf8Bytes: 12,
      itemListBytes: 42,
      response: { ret: -2, errcode: 17, errmsg: 'prepare failed', httpStatus: 200 },
    });

    const line = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    assert.equal(line.recordedAt, '2023-11-14T22:13:20.000Z');
    assert.equal(line.accountHash, 'a9b0ce902e64');
    assert.equal(line.userHash, 'fa32968772a8');
    assert.equal(line.tokenHash, 'f72d046e44f1');
    assert.equal(line.clientId, 'client-1');
    assert.deepEqual(line.response, { ret: -2, errcode: 17, errmsg: 'prepare failed', httpStatus: 200 });
    assert.equal(JSON.stringify(line).includes('token-secret'), false);
    assert.equal(JSON.stringify(line).includes('user-secret'), false);
    assert.equal(JSON.stringify(line).includes('account-secret'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
