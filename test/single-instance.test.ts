import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { acquireSingleInstance, SingleInstanceError } from '../src/utils/single-instance.js';

test('single-instance lock rejects a second live owner and releases cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-single-instance-'));
  const lockPath = join(dir, 'bridge.lock');
  try {
    const first = acquireSingleInstance(lockPath);
    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n`);
    assert.throws(() => acquireSingleInstance(lockPath), SingleInstanceError);

    first.release();
    const second = acquireSingleInstance(lockPath);
    second.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('single-instance lock removes a stale owner record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-single-instance-stale-'));
  const lockPath = join(dir, 'bridge.lock');
  try {
    writeFileSync(lockPath, `${Number.MAX_SAFE_INTEGER}\n`, 'utf8');
    const owner = acquireSingleInstance(lockPath);
    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n`);
    owner.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
