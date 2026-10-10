import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const modulesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/modules');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * A module may use another module only through that module's index.ts (its public API).
 * This keeps modules independent so any of them can later be extracted into its own service.
 */
describe('module boundaries', () => {
  it('only imports other modules through their index.ts', () => {
    const violations: string[] = [];
    for (const file of walk(modulesDir)) {
      const fromModule = relative(modulesDir, file).split(sep)[0];
      if (fromModule === 'index.ts') continue; // the registry
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
        const target = relative(modulesDir, resolve(dirname(file), spec!));
        const [toModule, ...rest] = target.split(sep);
        if (target.startsWith('..') || toModule === fromModule) continue;
        if (rest.join('/') !== 'index.js') violations.push(`${relative(modulesDir, file)} → ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
