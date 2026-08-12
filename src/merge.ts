import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Err, Ok, type Result } from './utils/Result.js';

export const CONFLICT_MARKER = /^(<{7}|>{7}) /m;

export interface MergeInput {
    local: string;
    base: string;
    incoming: string;
    labels: { local: string; base: string; incoming: string };
}

export interface MergeResult {
    text: string;
    conflicts: number;
}

/**
 * 3-way merge via git. Never writes to the working tree: returns the merged text plus
 * the conflict count, so --check and the real run share one code path.
 *
 * An Err means git itself could not do the merge — not that the merge had conflicts, which is
 * an ordinary outcome reported in `conflicts`.
 */
export function mergeFile({ local, base, incoming, labels }: MergeInput): Result<MergeResult, string> {
    const tmp = mkdtempSync(join(tmpdir(), 'neoskop-devcontainer-'));
    try {
        const paths = { local: join(tmp, 'local'), base: join(tmp, 'base'), incoming: join(tmp, 'incoming') };
        writeFileSync(paths.local, local);
        writeFileSync(paths.base, base);
        writeFileSync(paths.incoming, incoming);

        const result = spawnSync(
            'git',
            // prettier-ignore
            [
                'merge-file', '-p', '--diff3',
                '-L', labels.local, '-L', labels.base, '-L', labels.incoming,
                paths.local, paths.base, paths.incoming,
            ],
            { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
        );

        if (result.error) {
            return Err(`\`git merge-file\` could not be run (${result.error.message}). Is git installed?`);
        }
        // git merge-file: 0 = clean, 1..127 = number of conflicts, >=128 = failure.
        if (result.status === null || result.status >= 128) {
            return Err(`\`git merge-file\` failed: ${(result.stderr || '').trim() || `signal ${result.signal}`}`);
        }
        return Ok({ text: result.stdout, conflicts: result.status });
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}
