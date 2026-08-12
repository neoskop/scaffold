import type { Env } from '../env.js';
import { Reporter } from '../report.js';
import { parseSpec } from '../spec.js';
import { checkName, ScaffoldState, STATE_FILE } from '../state.js';
import { adoptTree, type SyncResult, syncTree } from '../sync.js';
import { neon } from '../utils/neon.js';
import { Err, Ok, type Result } from '../utils/Result.js';
import { Claims } from './_claims.js';
import { describeSpec, Source } from './_run.js';
import { checkRepo, type Flags } from './_utils.js';

export async function commandInit(
    root: string,
    env: Env,
    flags: Flags,
    positionals: readonly string[]
): Promise<Result<number, string>> {
    const repo = checkRepo(root);
    if (repo.isErr()) return repo.castErr();

    const [input, ...extra] = positionals;
    if (input === undefined) {
        return Err(`which repository?\n\n  ${env.pkg.name} init <repo>\n\n  Try --help for the forms.`);
    }
    if (extra.length > 0) return Err(`init takes one repository, but also got "${extra.join('", "')}".`);

    const parsed = parseSpec(input, { cwd: root });
    if (parsed.isErr()) return parsed.castErr();
    const spec = parsed.value;

    const loaded = ScaffoldState.read(root);
    if (loaded.isErr()) return loaded.castErr();
    const state = loaded.value;

    // The repository's own name, never an auto-suffixed variant: re-running `init` has to say
    // "already installed" rather than quietly producing a second copy. Two copies of one
    // template are a real use case, but an explicit --name is how you ask for them.
    const name = flags.name ?? spec.name;
    const named = checkName(name);
    if (named.isErr()) return named.castErr();

    const existing = state.get(name);
    if (existing !== undefined && !flags.force) {
        return Err(
            `scaffold "${name}" is already installed (${existing.repo} at ${existing.commit.slice(0, 8)}).\n\n` +
                `  Move it forward with:  ${env.pkg.name} update ${name}\n` +
                '  Install the same template a second time with --name <other>.\n' +
                '  Or pass --force to re-seed every file from the template.'
        );
    }

    const reporter = new Reporter();
    const got = await Source.open(env, spec, { hooks: flags.hooks });
    if (got.isErr()) return got.castErr();
    const source = got.value;

    try {
        const context = source.context({ root, name, spec, previousCommit: null, check: flags.check, reporter });

        // Anything the template refuses to be installed into — a missing package.json, the
        // inside of a container — belongs here, and aborts before a single byte is written.
        const preInit = await source.hooks.run('preInit', context);
        if (preInit.isErr()) return preInit.castErr();

        // Before the collision check rather than after: a file this project is never getting
        // cannot be fought over with another scaffold. With --no-hooks nothing is excluded —
        // there is no previous answer to replay on an install.
        const asked = await source.hooks.excluded(context, source.template.paths);
        if (asked.isErr()) return asked.castErr();
        const excluded = asked.value;

        const wanted = source.template.paths.filter((path) => !excluded.has(path));
        // What the scaffolds already installed here own, read out of their own recorded commits.
        // Nothing is fetched when this is the first scaffold in the project.
        const claimed = new Claims(root, env).owners(state, name, reporter);
        const collisions = wanted.filter((path) => claimed.has(path));
        if (collisions.length > 0 && !flags.force) {
            return Err(
                `these files are already managed by another scaffold:\n\n` +
                    collisions.map((path) => `    ${path}  (${claimed.get(path) as string})`).join('\n') +
                    '\n\n  Two scaffolds writing one file will fight on every update. Pass --force to take\n' +
                    '  them over anyway.'
            );
        }

        const pre = await source.hooks.run('preSync', context);

        const synced = pre.andThen((): Result<SyncResult, string> =>
            flags.adopt
                ? Ok(adoptTree(root, source.template, reporter, excluded))
                : syncTree(root, source.template, reporter, {
                      check: flags.check,
                      // init seeds: nothing is merged, so no base is needed.
                      force: true,
                      base: { kind: 'empty' },
                      excluded,
                      // Nothing was installed before, so there is nothing to reconstruct.
                      excludedAtBase: new Set(),
                      owners: new Map(),
                      name,
                      labels: { base: 'nothing', incoming: `${spec.repo}#${source.short}` },
                  })
        );
        if (synced.isErr()) return synced.castErr();
        const result = synced.value;

        const files = result.files;
        const after = context.withFiles(files);

        // A failure in either post hook is reported and downgraded to exit 1 rather than
        // propagated: the files are already on disk, and the state entry below is what makes
        // that recoverable.
        let code = 0;
        const postSync = await source.hooks.run('postSync', after);
        const post = await postSync.andThenAsync(() => source.hooks.run('postInit', after));
        if (post.isErr()) {
            reporter.record('warn', 'scaffold.hooks.mjs', post.err);
            code = 1;
        }

        // Written even when a hook failed, so the install is one `update` away from being
        // repaired rather than a pile of files that nothing claims.
        state.record(name, {
            repo: spec.repo,
            ref: spec.ref,
            commit: source.commit,
            excluded: [...excluded].sort(),
        });
        if(!flags.check) {
            state.write(root);
        }

        env.log(`\n${neon.bold`${name}`} ← ${describeSpec(spec)} ${neon.dim`(${source.short})`}\n`);
        reporter.flush(env.log, flags.check);
        env.log(
            [
                '',
                neon.bold`Next steps`,
                '  1. Review and commit the changes.',
                `  2. Later: ${env.pkg.name} update${flags.hooks ? '' : ' --no-hooks'}`,
                '',
                neon.dim`Every installed file can be customized — an update 3-way merges your changes`,
                neon.dim`back in — against the commit ${STATE_FILE} records as installed.`,
                '',
            ].join('\n')
        );

        if (flags.adopt && result.changes > 0) {
            env.log(
                [
                    `${neon.bold.yellow`Heads up:`} ${result.changes} file(s) differ from the template and were kept as-is.`,
                    '  --adopt records your files as the desired state, so they are NOT upgraded now —',
                    '  only future template changes merge in. Review the diff before committing.',
                    '',
                    '  If you wanted the template version, re-run with --force instead.',
                    '',
                ].join('\n')
            );
        }

        return Ok(code);
    } finally {
        source.dispose();
    }
}
