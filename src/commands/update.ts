import { resolve } from 'node:path';

import type { Env } from '../env.js';
import { Reporter } from '../report.js';
import { parseRefFlag, parseSpec, type Ref, type RepoSpec, specFromState, withRef } from '../spec.js';
import { type ScaffoldEntry, ScaffoldState, STATE_FILE } from '../state.js';
import { type Base, syncTree } from '../sync.js';
import { Template } from '../template.js';
import { neon } from '../utils/neon.js';
import { Err, Ok, type Result } from '../utils/Result.js';
import { Claims } from './_claims.js';
import { resolveCommit, Source } from './_run.js';
import { checkRepo, type Flags } from './_utils.js';

export async function commandUpdate(
    root: string,
    env: Env,
    flags: Flags,
    positionals: readonly string[]
): Promise<Result<number, string>> {
    const loaded = checkRepo(root).andThen(() => ScaffoldState.read(root));
    if (loaded.isErr()) return loaded.castErr();
    const state = loaded.value;

    if (state.isEmpty) {
        return Err(`${STATE_FILE} has no scaffolds — nothing to update.\n\n  Install one: ${env.pkg.name} init <repo>`);
    }
    const known = state.names;

    const names = positionals.length > 0 ? [...positionals] : known;
    for (const name of names) {
        if (!state.has(name)) {
            return Err(`no scaffold named "${name}".\n\n  Installed: ${known.join(', ')}`);
        }
    }
    if (names.length > 1 && (flags.ref !== undefined || flags.repo !== undefined || flags.base !== undefined)) {
        return Err('--ref, --repo and --base apply to one scaffold. Name it: update <name> --ref <r>');
    }

    let changes = 0;
    let conflicts = 0;
    let moved = false;
    let code = 0;

    // One instance for the whole run: every scaffold asks what the others own, and each answer is
    // a checkout worth reusing.
    const claims = new Claims(root, env);

    for (const name of names) {
        const reporter = new Reporter();
        const outcome = await one(root, env, flags, state, name, claims, reporter);
        if (outcome.isErr()) {
            // One scaffold's failure must not abandon the ones after it, and must not undo the
            // ones already written. Report, remember, carry on — which is why `one` hands the
            // failure back as a value instead of it reaching the top of the process.
            env.error(`\n${neon.bold`${name}`}\n  ${neon.bold.red`error`} ${outcome.err}`);
            code = 2;
            continue;
        }
        changes += outcome.value.changes;
        conflicts += outcome.value.conflicts;
        moved ||= outcome.value.moved;
        code = Math.max(code, outcome.value.code);
    }

    if (flags.check) {
        if (changes === 0 && !moved && code === 0) {
            env.log(`\n${neon.green`up to date`}\n`);
            return Ok(0);
        }
        if (code === 2) return Ok(2);
        env.log(`\n${neon.yellow`out of sync`} — run ${neon.bold`${env.pkg.name} update`}.\n`);
        return Ok(1);
    }

    if (conflicts > 0) {
        env.log(
            [
                '',
                neon.bold.red`${conflicts} file(s) need manual resolution.`,
                '  Conflict markers are in place — resolve them like a git merge conflict, then verify:',
                `    ${env.pkg.name} update --check`,
                '',
            ].join('\n')
        );
        return Ok(1);
    }

    if (code === 0) env.log(`\n${changes === 0 ? 'nothing to do' : `${neon.green`done`} — review the diff and commit`}\n`);
    return Ok(code);
}

interface Outcome {
    changes: number;
    conflicts: number;
    moved: boolean;
    code: number;
}

async function one(
    root: string,
    env: Env,
    flags: Flags,
    state: ScaffoldState,
    name: string,
    claims: Claims,
    reporter: Reporter
): Promise<Result<Outcome, string>> {
    const entry = state.get(name) as ScaffoldEntry;
    const from = entry.commit.slice(0, 8);

    let spec: RepoSpec;
    if (flags.repo !== undefined) {
        const parsed = parseSpec(flags.repo, { cwd: root });
        if (parsed.isErr()) return parsed.castErr();
        spec = parsed.value;
    } else {
        spec = specFromState(entry.repo, entry.ref, root);
    }

    let ref: Ref;
    if (flags.ref !== undefined) {
        const parsed = parseRefFlag(flags.ref);
        if (parsed.isErr()) return parsed.castErr();
        ref = parsed.value;
    } else {
        ref = flags.repo !== undefined ? spec.ref : entry.ref;
    }

    const wanted = withRef(spec, ref);

    // Resolving is the one unavoidable round trip. Under --check a failure is "we cannot tell",
    // which is not the same as "out of date" and must not be reported as it.
    const commit = resolveCommit(env, wanted);
    if (commit.isErr()) {
        if (!flags.check) return commit.castErr();
        reporter.record('warn', STATE_FILE, `could not reach ${spec.repo} — ${commit.err}`);
        env.log(`\n${neon.bold`${name}`} ${neon.dim`(${from})`}\n`);
        reporter.flush(env.log, true);
        return Ok({ changes: 0, conflicts: 0, moved: false, code: 2 });
    }

    const got = await Source.open(env, wanted, { commit: commit.value, hooks: flags.hooks });
    if (got.isErr()) return got.castErr();
    const source = got.value;

    // The base is a second checkout, in its own temp directory. Nothing reclaims it but us.
    let disposeBase: (() => void) | undefined;

    try {
        const resolved = resolveBase(root, env, entry, source, flags, reporter);
        if (resolved.isErr()) return resolved.castErr();
        disposeBase = resolved.value.dispose;
        const base = resolved.value.base;
        const moved = source.commit !== entry.commit;

        // The base tree is also the answer to "what does this scaffold own" for every other
        // scaffold in the project, so hand it over before anyone pays to fetch it again.
        if (base.kind === 'tree') claims.seed(entry.repo, entry.commit, base.tree);

        const context = source.context({
            root,
            name,
            spec: wanted,
            previousCommit: entry.commit,
            check: flags.check,
            reporter,
        });
        const preUpdate = await source.hooks.run('preUpdate', context);
        const pre = await preUpdate.andThenAsync(() => source.hooks.run('preSync', context));
        if (pre.isErr()) return pre.castErr();

        // With hooks on, the template decides again — this repository may have become a pnpm one
        // since the last run, or stopped being one. With --no-hooks nobody asked, so the recorded
        // answer stands: re-deriving it as "nothing is excluded" would report every excluded file
        // as missing on every CI run.
        const asked = source.hooks.consulted
            ? await source.hooks.excluded(context, source.template.paths)
            : Ok<ReadonlySet<string>>(new Set(entry.excluded));
        if (asked.isErr()) return asked.castErr();
        const excluded = asked.value;

        const synced = pre.andThen(() =>
            syncTree(root, source.template, reporter, {
                check: flags.check,
                force: flags.force,
                base,
                excluded,
                excludedAtBase: new Set(entry.excluded),
                owners: claims.owners(state, name, reporter),
                name,
                labels: {
                    base: `${spec.repo}#${from}`,
                    incoming: `${spec.repo}#${source.short}`,
                },
            })
        );
        if (synced.isErr()) return synced.castErr();

        const files = synced.value.files;
        const after = context.withFiles(files);
        let code = 0;

        // The post hooks run under --check too, or the files they own would be invisible to CI.
        // Only the consequence of a failure differs.
        const postSync = await source.hooks.run('postSync', after);
        const post = await postSync.andThenAsync(() => source.hooks.run('postUpdate', after));

        if (flags.check) {
            // Nothing was written, so there is nothing to record and nothing to downgrade to.
            if (post.isErr()) return post.castErr();
        } else {
            // Reported rather than propagated: the files are written, and the state entry below
            // is what leaves the install one `update` away from being repaired.
            if (post.isErr()) {
                reporter.record('warn', 'scaffold.hooks.mjs', post.err);
                code = 1;
            }

            // Per scaffold, never batched: a later failure must not roll this one back.
            state.record(name, {
                repo: spec.repo,
                ref,
                commit: source.commit,
                excluded: [...excluded].sort(),
            });
            state.write(root);
        }

        env.log(
            `\n${neon.bold`${name}`} ${spec.repo} ${from}${
                moved ? ` → ${neon.bold`${source.short}`}` : neon.dim` (already current)`
            }\n`
        );
        reporter.flush(env.log, flags.check);

        return Ok({ changes: reporter.changes, conflicts: reporter.conflicts.length, moved, code });
    } finally {
        disposeBase?.();
        source.dispose();
    }
}

/**
 * The merge base: an explicit override, the incoming tree when nothing moved, or the template
 * at the commit that is recorded as applied.
 *
 * Note that when --repo or --ref moved the scaffold to a different remote, the base still comes
 * from the OLD one at the OLD commit. That is the point of recording a commit rather than a
 * version: the ancestor is exactly reproducible even across a repository move.
 */
function resolveBase(
    root: string,
    env: Env,
    entry: ScaffoldEntry,
    incoming: Source,
    flags: Flags,
    reporter: Reporter
): Result<{ base: Base; dispose?: () => void }, string> {
    if (flags.base !== undefined) {
        const dir = resolve(root, flags.base);
        return Template.walk(dir)
            // Someone else's directory: read it, never remove it — so there is no dispose here.
            .map((tree): { base: Base } => ({ base: { kind: 'tree', tree } }))
            .mapErr(
                (reason) =>
                    `${dir} does not look like a template checkout (${reason}).\n\n` +
                    '  --base wants the repository root, the directory that contains template/.'
            );
    }

    // Steady state: what was just fetched IS the base, so there is no second clone. Its disposal
    // belongs to the caller that fetched it, not here.
    if (incoming.commit === entry.commit) return Ok({ base: { kind: 'tree', tree: incoming.template } });

    const previous = specFromState(entry.repo, { kind: 'commit', value: entry.commit }, root);
    const fetched = env.remote.checkout(previous, entry.commit);
    if (fetched.isOk()) {
        const checkout = fetched.value;
        const walked = Template.walk(checkout.dir);
        if (walked.isOk()) {
            return Ok({ base: { kind: 'tree', tree: walked.value }, dispose: () => checkout.dispose() });
        }
        checkout.dispose();
        return Ok({ base: { kind: 'unavailable', reason: walked.err } });
    }

    // Writing would mean merging against nothing, which turns every customized file into a
    // conflict. Refuse instead.
    if (!flags.check) {
        return Err(
            `cannot fetch ${entry.repo} at ${entry.commit.slice(0, 8)}, which is the merge base (${fetched.err}).\n\n` +
                '  Without it every local change would come back as a conflict, so nothing was written.\n' +
                '  Retry with network access, or point at a local checkout of that commit:\n\n' +
                `    ${env.pkg.name} update --base <path-to-checkout>\n`
        );
    }

    reporter.record('warn', STATE_FILE, `merge base ${entry.commit.slice(0, 8)} unavailable — ${fetched.err}`);
    return Ok({ base: { kind: 'unavailable', reason: fetched.err } });
}
