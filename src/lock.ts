// Single-writer lock: only one process may index and send. A lock held by a dead pid is taken over.
import { mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      const release = () => {
        try {
          if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
      process.once('exit', release);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = Number(readFileSync(path, 'utf8'));
      if (holder && alive(holder) && holder !== process.pid) {
        throw new Error(`another writer (pid ${holder}) holds ${path}`);
      }
      unlinkSync(path); // stale
    }
  }
  throw new Error(`could not acquire ${path}`);
}
