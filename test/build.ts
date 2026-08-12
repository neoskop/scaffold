import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Compile once before the suite runs. test/bin.test.ts drives bin/bin.mjs against the compiled
 * dist/, which is exactly what npm publishes — the shebang, the exit codes and the resolution
 * from bin/ into dist/ are only real there.
 */
export function setup(): void {
    const tsc = spawnSync(
        process.execPath,
        [join(PACKAGE_ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js'), '-p', 'tsconfig.build.json'],
        { cwd: PACKAGE_ROOT, encoding: 'utf8' }
    );
    if (tsc.status !== 0) {
        throw new Error(`tsc failed (exit ${tsc.status}):\n${tsc.stdout}${tsc.stderr}`);
    }
}
