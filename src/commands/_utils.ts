import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Err, Ok, type Result } from '../utils/Result.js';

export interface Flags {
    check: boolean;
    force: boolean;
    adopt: boolean;
    hooks: boolean;
    /** A checkout directory to merge against instead of fetching the recorded commit. */
    base?: string;
    name?: string;
    ref?: string;
    repo?: string;
}

export function toFlags(overrides: Partial<Flags>): Flags {
    return {
        check: false,
        force: false,
        adopt: false,
        hooks: true,
        ...overrides,
    };
}

/**
 * Scaffolding overwrites and merges files in place. Without version control there is no way to
 * review what it did or undo it, and `git merge-file` — which does the merging — would not be
 * there either.
 */
export function checkRepo(root: string): Result<void, string> {
    if (!existsSync(join(root, '.git'))) {
        return Err(
            `${root} is not a git repository.\n\n` +
                '  Scaffolding rewrites files in place; without git there is no way to review the\n' +
                '  result or undo it. Run `git init` first.'
        );
    }
    return Ok();
}
