import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export class SingleInstanceError extends Error {
  constructor(public readonly lockPath: string, public readonly ownerPid?: number) {
    super(ownerPid
      ? `bridge is already running (pid ${ownerPid}): ${lockPath}`
      : `bridge lock is unavailable: ${lockPath}`);
    this.name = 'SingleInstanceError';
  }
}

export interface SingleInstanceHandle {
  readonly lockPath: string;
  release(): void;
}

function readOwnerPid(lockPath: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireSingleInstance(lockPath: string): SingleInstanceHandle {
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }

      let released = false;
      return {
        lockPath,
        release(): void {
          if (released) return;
          released = true;
          if (readOwnerPid(lockPath) !== process.pid) return;
          try { unlinkSync(lockPath); } catch { /* best effort during shutdown */ }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      const ownerPid = readOwnerPid(lockPath);
      if (isProcessAlive(ownerPid)) throw new SingleInstanceError(lockPath, ownerPid);
      try {
        if (existsSync(lockPath)) unlinkSync(lockPath);
      } catch {
        throw new SingleInstanceError(lockPath, ownerPid);
      }
    }
  }

  throw new SingleInstanceError(lockPath);
}
