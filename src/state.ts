//
// /.scaffold.json — what is installed and where it came from.
//
// Keyed by scaffold name, so several templates can live in one project without knowing about
// each other. Only decisions are recorded here:
//
//   repo    where the template comes from, ref stripped.
//   ref     what the project WANTS. Re-resolved on every update; a new tag here with the old
//           commit below is exactly "there is a release you have not taken yet".
//   commit  what is APPLIED, and therefore the merge base for the next update.
//
// Which paths a scaffold owns is deliberately NOT in here: the template at `commit` is that
// list, minus `excluded` — see `ownedAt` in sync.ts. A second copy in a committed, hand-editable
// file could only ever disagree with the tree it was derived from.
//
// And one field that is a cache rather than a decision: `excluded`, what the template's own
// exclude hook left out. It is recorded because --no-hooks never asks that hook, and a CI check
// that cannot ask has to be able to look up the last answer instead of guessing "missing". It is
// also what makes the owned set above exactly reproducible.

import { join } from 'node:path';

import { read, write } from './fs.js';
import type { Ref, RefKind } from './spec.js';
import { Err, Ok, type Result } from './utils/Result.js';

export const STATE_FILE = '.scaffold.json';

export interface ScaffoldEntry {
    /** Canonical repository identity, ref stripped. */
    repo: string;
    ref: Ref;
    /** The applied commit: 40 hex, and the merge base for the next update. */
    commit: string;
    /**
     * Paths the template ships that its `exclude` hook left out of this project, sorted. Recorded
     * for two reasons: `--no-hooks` — which is what CI runs, and which therefore never asks the
     * hook — can replay the answer instead of reporting every excluded file as missing forever,
     * and it is what turns the template at `commit` back into the set of paths this scaffold owns.
     */
    excluded: readonly string[];
}

const REF_KINDS: readonly RefKind[] = ['default', 'branch', 'tag', 'commit', 'rev'];
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** The parsed /.scaffold.json of one project. */
export class ScaffoldState {
    private constructor(
        private readonly entries: Map<string, ScaffoldEntry>,
        /** Anything a newer version of the CLI wrote, carried through untouched. */
        readonly extra: Record<string, unknown>
    ) {}

    static empty(): ScaffoldState {
        return new ScaffoldState(new Map(), {});
    }

    /** A missing file is not an error: it is a project with no scaffolds in it yet. */
    static read(root: string): Result<ScaffoldState, string> {
        const raw = read(join(root, STATE_FILE));
        if (raw === null) return Ok(ScaffoldState.empty());

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            // Refusing beats clobbering: the file is committed, and a half-written one is a merge
            // conflict someone still has to look at.
            return Err(`${STATE_FILE} is not valid JSON. Fix or delete it, then run this again.`);
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return Err(`${STATE_FILE} does not contain a JSON object.`);
        }

        const { scaffolds, ...extra } = parsed as Record<string, unknown>;
        const entries = new Map<string, ScaffoldEntry>();

        if (scaffolds !== undefined) {
            if (typeof scaffolds !== 'object' || scaffolds === null || Array.isArray(scaffolds)) {
                return Err(`${STATE_FILE}: "scaffolds" must be an object.`);
            }
            for (const [name, value] of Object.entries(scaffolds as Record<string, unknown>)) {
                const entry = readEntry(name, value);
                if (entry.isErr()) return entry.castErr();
                entries.set(name, entry.value);
            }
        }

        return Ok(new ScaffoldState(entries, extra));
    }

    /** The installed scaffolds, in the order the file listed them. */
    get names(): string[] {
        return [...this.entries.keys()];
    }

    get isEmpty(): boolean {
        return this.entries.size === 0;
    }

    get(name: string): ScaffoldEntry | undefined {
        return this.entries.get(name);
    }

    has(name: string): boolean {
        return this.entries.has(name);
    }

    /** Install a scaffold, or move an installed one to what was just applied. */
    record(name: string, entry: ScaffoldEntry): void {
        this.entries.set(name, entry);
    }

    /** Every installed scaffold, in the order the file listed them. */
    get all(): [string, ScaffoldEntry][] {
        return [...this.entries];
    }

    write(root: string): void {
        const scaffolds: Record<string, unknown> = {};
        for (const name of [...this.entries.keys()].sort()) {
            const entry = this.entries.get(name) as ScaffoldEntry;
            scaffolds[name] = {
                repo: entry.repo,
                ref: entry.ref,
                commit: entry.commit,
                // Sorted, so a diff shows what changed rather than how the hook happened to order
                // it. Omitted when there is nothing to say, so the file of a template that
                // excludes nothing — which is most of them — does not grow an empty array.
                ...(entry.excluded.length > 0 ? { excluded: [...entry.excluded].sort() } : {}),
            };
        }
        const body = { ...this.extra, scaffolds };
        write(join(root, STATE_FILE), `${JSON.stringify(body, null, 4)}\n`);
    }
}

function readEntry(name: string, value: unknown): Result<ScaffoldEntry, string> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return Err(`${STATE_FILE}: scaffold "${name}" is not an object.`);
    }
    const entry = value as Record<string, unknown>;
    const repo = entry['repo'];
    const commit = entry['commit'];
    if (typeof repo !== 'string' || repo === '') return Err(`${STATE_FILE}: scaffold "${name}" has no "repo".`);
    if (typeof commit !== 'string' || commit === '') return Err(`${STATE_FILE}: scaffold "${name}" has no "commit".`);

    const rawRef = entry['ref'];
    let ref: Ref = { kind: 'commit', value: commit };
    if (typeof rawRef === 'object' && rawRef !== null && !Array.isArray(rawRef)) {
        const kind = (rawRef as Record<string, unknown>)['kind'];
        const refValue = (rawRef as Record<string, unknown>)['value'];
        if (typeof kind === 'string' && (REF_KINDS as readonly string[]).includes(kind)) {
            ref = { kind: kind as RefKind, value: typeof refValue === 'string' ? refValue : '' };
        }
    }

    // Anything else in there — including the "files" list older versions wrote — is dropped: it
    // is derived from `commit`, so re-deriving it is both cheaper and always right.
    return readPaths(name, entry['excluded']).map((excluded) => ({ repo, ref, commit, excluded }));
}

/**
 * A list of repo-relative paths. The file is committed and hand-editable, so anything that could
 * steer a write outside the project is refused rather than sanitized away.
 */
function readPaths(name: string, value: unknown): Result<string[], string> {
    if (!Array.isArray(value)) return Ok([]);
    const out: string[] = [];
    for (const path of value) {
        if (typeof path !== 'string') continue;
        if (!safePath(path)) return Err(`${STATE_FILE}: scaffold "${name}" lists an unusable path "${path}".`);
        out.push(path);
    }
    return Ok(out.sort());
}

function safePath(path: string): boolean {
    if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
    if (/^[A-Za-z]:/.test(path)) return false;
    return !path.split('/').includes('..');
}

export function checkName(name: string): Result<void, string> {
    if (!NAME.test(name)) {
        return Err(`"${name}" is not a usable scaffold name — letters, digits and . _ - only.`);
    }
    return Ok();
}
