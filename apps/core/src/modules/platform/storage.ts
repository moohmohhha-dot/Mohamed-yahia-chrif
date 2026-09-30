import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** Where uploaded files live. Local disk today; an S3-compatible driver can implement the same interface. */
export interface FileStorage {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
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
    get: (key) => readFile(pathOf(key)),
  };
}
