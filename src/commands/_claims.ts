//
// Which paths the OTHER scaffolds in this project own.
//
// Two scaffolds writing one file would fight on every update, so both commands have to know what
// is already claimed before they write: `init` refuses outright, `update` reports a conflict.
//
// `/.scaffold.json` does not carry that list — a scaffold's files are the template at its recorded
// commit, minus the `exclude` answer recorded beside it (the same reconstruction `ownedAt` does
// for the scaffold being synced, only for a commit nothing fetched yet). So this walks each other
// scaffold's own base tree to find out.
//
// That costs a checkout per other scaffold, which is why the answers are cached per repo@commit
// and why a tree the caller already has can be handed over instead: a project with one scaffold —
// the normal case — never fetches anything here at all.

import type { Env } from '../env.js';
import type { Reporter } from '../report.js';
import { specFromState } from '../spec.js';
import { type ScaffoldEntry, type ScaffoldState, STATE_FILE } from '../state.js';
import { Template } from '../template.js';

export class Claims {
    /** repo@commit → what that tree installs, or null when it could not be had. */
    private readonly trees = new Map<string, readonly string[] | null>();

    constructor(
        private readonly root: string,
        private readonly env: Env
    ) {}

    /**
     * Record a tree the caller already fetched, so it is not fetched a second time.
     *
     * Only the paths are kept, never the {@link Template} — the checkout it reads from belongs to
     * whoever fetched it and may be gone by the time another scaffold asks.
     */
    seed(repo: string, commit: string, tree: Template): void {
        this.trees.set(key(repo, commit), tree.paths);
    }

    /**
     * Every path owned by a scaffold other than `except`, mapped to its owner.
     *
     * A scaffold whose tree cannot be fetched is reported and skipped rather than treated as
     * owning nothing: guessing would let two scaffolds quietly fight over a file, and failing
     * would let one unreachable remote block every update in the project.
     */
    owners(state: ScaffoldState, except: string | undefined, reporter: Reporter): ReadonlyMap<string, string> {
        const map = new Map<string, string>();

        for (const [name, entry] of state.all) {
            if (name === except) continue;

            const paths = this.pathsOf(entry);
            if (paths === null) {
                reporter.record(
                    'warn',
                    STATE_FILE,
                    `cannot read what scaffold "${name}" owns (${entry.repo} at ${entry.commit.slice(0, 8)}) — ` +
                        'files shared with it were not checked'
                );
                continue;
            }

            const excluded = new Set(entry.excluded);
            for (const path of paths) {
                // What this project never gets cannot be fought over.
                if (!excluded.has(path)) map.set(path, name);
            }
        }

        return map;
    }

    /** null is "could not be had", cached like a hit so a dead remote is asked once per run. */
    private pathsOf(entry: ScaffoldEntry): readonly string[] | null {
        const cached = this.trees.get(key(entry.repo, entry.commit));
        if (cached !== undefined) return cached;

        const spec = specFromState(entry.repo, { kind: 'commit', value: entry.commit }, this.root);
        const fetched = this.env.remote.checkout(spec, entry.commit);
        if (fetched.isErr()) {
            this.trees.set(key(entry.repo, entry.commit), null);
            return null;
        }

        const checkout = fetched.value;
        try {
            const walked = Template.walk(checkout.dir);
            const paths = walked.isOk() ? walked.value.paths : null;
            this.trees.set(key(entry.repo, entry.commit), paths);
            return paths;
        } finally {
            // Nothing beyond the path list survives this call, so the temp directory goes now
            // rather than at the end of the command.
            checkout.dispose();
        }
    }
}

function key(repo: string, commit: string): string {
    return `${repo}@${commit}`;
}
