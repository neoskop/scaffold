import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { commandInit } from './commands/init.js';
import { commandUpdate } from './commands/update.js';
import { toFlags } from './commands/_utils.js';
import type { Env } from './env.js';
import { neon } from './utils/neon.js';
import { Err, Ok, type Result } from './utils/Result.js';
import { Riker } from './utils/riker.js';

/** Resolves --dir against the environment's cwd, refusing a target that is not there. */
function targetRoot(dir: string | undefined, env: Env): Result<string, string> {
    const root = resolve(dir ?? env.cwd);
    return existsSync(root) ? Ok(root) : Err(`${root} does not exist`);
}

/**
 * The whole command surface. Built per invocation because `Env` — the output sinks and the
 * remote this run talks to — differs between the real binary and every test.
 */
function cli(env: Env, argv: readonly string[]): Result<number, string> | Promise<Result<number, string>> {
    const bin = `pnpm dlx ${env.pkg.name}@latest`;

    return new Riker({
        name: env.pkg.name,
        bin,
        version: env.pkg.version,
        description: env.pkg.description,
        usage: [
            `${bin} init <repo> [--name <n>] [--adopt|--force]`,
            `${bin} update [name...] [--check]`,
            neon.dim`${bin} <command> --help   for a command's own flags`,
        ],
        epilog: [
            neon.bold`The repo argument`,
            '  org/repo            GitHub, default branch',
            '  org/repo/branch     GitHub, a branch (may contain slashes)',
            '  org/repo@tag        GitHub, a tag',
            '  org/repo#hash       GitHub, a commit',
            '  git@host:org/repo   any SSH remote          (add #<ref> to pin)',
            '  https://host/o/r    any HTTPS remote        (add #<ref> to pin)',
            '  ./path/to/repo      a local git repository  (add #<ref> to pin)',
            '',
            neon.bold`What survives an update`,
            '  Everything the template installs is fair game to customize: an update 3-way merges',
            '  each file against the commit recorded in .scaffold.json. Your changes either merge',
            "  cleanly or come back as conflict markers — nothing is overwritten silently, and a",
            '  file you changed is never deleted just because the template stopped shipping it.',
            '',
            neon.bold`${neon.brightYellow.bold`WARNING:`} Hooks run code from the template repository`,
            '  A template may ship a scaffold.hooks.mjs, which runs on your machine with your',
            '  privileges — the same trust as piping that repo’s install script into a shell. Pin',
            '  a tag or commit for anything automated, and pass --no-hooks in CI.',
        ],
        log: env.log,
        error: env.error,
    })
        .flag({
            name: 'dir',
            type: 'string',
            placeholder: '<path>',
            description: 'Target repository (default: the current directory).',
        })
        .flag({
            name: 'hooks',
            allowNo: true,
            default: true,
            hidden: true,
            description: "Run the template's scaffold.hooks.mjs. --no-hooks skips it.",
        })
            // Undocumented alias, kept because it is what people type out of habit.
            .flag({ name: 'dry-run', hidden: true })
        .command('init', 'Install a scaffold from a git repository.', '<repo>')
            .flag({
                name: 'name',
                type: 'string',
                placeholder: '<name>',
                description: 'Key to record it under (default: the repository name).',
            })
            .flag({
                name: 'adopt',
                description:
                    'Keep files that already exist as-is and only record them. They stay\nthe desired state — they are NOT replaced by the template, only\nfuture template changes merge in.',
            })
            .flag({ name: 'force', description: 'Overwrite existing files / re-seed an existing install.' })
            .command((flags, positionals) =>
                targetRoot(flags.dir, env).andThenAsync((root) =>
                    commandInit(
                        root,
                        env,
                        toFlags({
                            check: flags['dry-run'],
                            force: flags.force,
                            adopt: flags.adopt,
                            hooks: flags.hooks,
                            ...(flags.name === undefined ? {} : { name: flags.name }),
                        }),
                        positionals
                    )
                )
            )
            .end()
        .command('update', 'Move scaffolds to their current ref, 3-way merging local changes.', '[name...]')
            .flag({
                name: 'check',
                description:
                    'Report what would change, write nothing. Exits 1 when out\nof sync or when conflict markers are unresolved. Meant for CI.',
            })
            .flag({ name: 'force', description: 'Re-seed managed files from the template, discarding local changes.' })
            .flag({
                name: 'ref',
                type: 'string',
                placeholder: '<ref>',
                description: 'Move to this branch, tag or commit and record it.',
            })
            .flag({
                name: 'repo',
                type: 'string',
                placeholder: '<spec>',
                description: 'Move the scaffold to a different template repository.',
            })
            .flag({
                name: 'base',
                type: 'string',
                placeholder: '<dir>',
                description:
                    'Merge base: a checkout of the template repository. The default\nis to fetch the recorded commit — use this without network access.',
            })
            .command((flags, positionals) =>
                targetRoot(flags.dir, env).andThenAsync((root) =>
                    commandUpdate(
                        root,
                        env,
                        toFlags({
                            check: flags.check || flags['dry-run'],
                            force: flags.force,
                            hooks: flags.hooks,
                            ...(flags.ref === undefined ? {} : { ref: flags.ref }),
                            ...(flags.repo === undefined ? {} : { repo: flags.repo }),
                            ...(flags.base === undefined ? {} : { base: flags.base }),
                        }),
                        positionals
                    )
                )
            )
            .end()
        .run(argv);
}

/**
 * Runs one invocation and returns its exit code.
 *
 * The one place an Err turns into output and a status: every user error in this package travels
 * here as a value, so nothing below has to decide between reporting and rethrowing. A throw
 * reaching this far is therefore a bug in the CLI rather than a mistake by its user, and is left
 * to escape with its stack intact.
 */
export async function run(argv: readonly string[], env: Env): Promise<number> {
    return (await cli(env, argv)).unwrapOrElse((message) => {
        env.error(`${neon.bold.red`error`} ${message}`);
        return 2;
    });
}
