import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** Where uploaded files live. Local disk today; an S3-compatible driver can implement the same interface. */
export interface FileStorage {
  /** Writes a new file; refuses to overwrite one. */
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Replaces an existing file atomically (used only to re-encrypt files after a key rotation). */
  replace(key: string, body: Buffer): Promise<void>;
}

export function createLocalStorage(rootDir: string): FileStorage {
  const root = resolve(rootDir);
  const pathOf = (key: string) => {
    const path = resolve(join(root, key));
    if (!path.startsWith(root + sep)) throw new Error('Invalid storage key');
    return path;
  };
  return {
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, { flag: 'wx' });
    },
    get: async (key) => readFile(pathOf(key)),
    async replace(key, body) {
      const path = pathOf(key);
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, body, { flag: 'wx' });
      await rename(temp, path);
    },
  };
}
