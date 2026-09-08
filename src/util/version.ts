import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * This package's own version, for the CLIs to report.
 *
 * Read from `package.json` at run time rather than imported, because the build
 * emits from `src` into `dist` and a JSON import would have to survive that move
 * unchanged; npm always ships `package.json`, so reading it is dependable in a
 * way that resolving a path across the build is not. A version is never worth
 * failing a command over, so anything unreadable reports as unknown.
 */
export function packageVersion(): string {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
    const { version } = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
