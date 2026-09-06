import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether this module is the program being run, rather than one being imported.
 *
 * Bun offers `import.meta.main`, but Node does not, and the published CLIs run
 * under both. Comparing the module's path to the one the process was started
 * with works everywhere; `realpath` keeps it correct when the command was
 * reached through a symlink, which is how npm installs a `bin`.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}
