//
// scaffold.hooks.mjs — the template repository's own code.
//
// Copying files covers most of a scaffold, but not the part where an installed thing has to be
// *registered* in a file the project owns: a line in .gitignore, an entry in .mcp.json. That is
// what hooks are for, and it belongs to the template rather than to this CLI, which is what
// makes the CLI general-purpose at all.
//
// The same argument covers `exclude`: whether a project should get `.pnpmfile.mjs` is a question
// only the template can answer, and answering it here would mean this CLI knowing about package
// managers.
//
// SECURITY. This imports and runs code from a remote repository, in this process, on the host,
// unsandboxed, with the invoking user's privileges. `scaffold init org/repo` is as dangerous as
// piping that repository's install script into a shell. There is no sandbox that would leave
// hooks able to do their job, so the tool is loud about it instead: it announces the file it is
// about to run, and `--no-hooks` skips them entirely — which is what CI should use.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ReportKind } from './report.js';
import type { Ref } from './spec.js';
import { TEMPLATE_DIR } from './template.js';
import { Err, Ok, type Result } from './utils/Result.js';

export const HOOKS_FILE = 'scaffold.hooks.mjs';
export const NO_HOOKS = 'NEOSKOP_SCAFFOLD_NO_HOOKS';

/**
 * `preSync`/`postSync` bracket the file sync itself and run for both commands, so work a
 * template has to do either way is written once instead of twice.
 */
export const HOOK_NAMES = [
    'preInit',
    'postInit',
    'preUpdate',
    'postUpdate',
    'preSync',
    'postSync',
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

/**
 * Not one of {@link HOOK_NAMES}: it is consulted rather than run. It answers a question — which
 * of the files this template ships belong in *this* project — instead of doing something, so it
 * returns a value, must not write, and is called once, before anything else could have changed
 * what it looks at.
 */
export const EXCLUDE_HOOK = 'exclude';

/** Everything but the methods: what {@link HookContext} is built from. */
export type HookContextInit = Omit<HookContext, 'withFiles'>;

/** The one argument a hook gets. Plain data, because it crosses into the template's own code. */
export class HookContext {
    /** Absolute path of the target repository. */
    readonly cwd: string;
    /** Absolute path of the checkout's `template/`. */
    readonly templateDir: string;
    /** Absolute path of the checkout root — where this hooks file itself lives. */
    readonly repoDir: string;
    /** The key under "scaffolds" in .scaffold.json. One template may be installed twice. */
    readonly name: string;
    readonly ref: Ref;
    readonly commit: string;
    /** Null on init. The commit being moved away from, so a hook can migrate. */
    readonly previousCommit: string | null;
    /** True under --check. A hook MUST report what it would do and write nothing. */
    readonly check: boolean;
    /**
     * Paths the file sync touched. Empty in the `pre` hooks, and in `exclude` every path the
     * template would install — the set that hook is picking from.
     */
    readonly files: readonly string[];
    /**
     * A line in the report. The kind is not decoration: `added`/`updated`/`removed` and the rest
     * of the change kinds are what `--check` counts, so a hook that only ever logs strings would
     * let CI go green while the files it owns are out of date.
     */
    readonly log: (kind: ReportKind, path: string, detail?: string) => void;

    constructor(init: HookContextInit) {
        this.cwd = init.cwd;
        this.templateDir = init.templateDir;
        this.repoDir = init.repoDir;
        this.name = init.name;
        this.ref = init.ref;
        this.commit = init.commit;
        this.previousCommit = init.previousCommit;
        this.check = init.check;
        this.files = init.files;
        this.log = init.log;
    }

    /** The same context once the sync has run and there are paths to hand the `post` hooks. */
    withFiles(files: readonly string[]): HookContext {
        return new HookContext({ ...this, files });
    }
}

export type Hook = (context: HookContext) => void | Promise<void>;
export type HookModule = Partial<Record<HookName, Hook>>;

/**
 * Which of `context.files` this project should NOT get. Returning the paths to drop rather than
 * the ones to keep is what makes the hook unable to widen a template: whatever it hands back is
 * subtracted, so a path that is not in `template/` cannot be conjured into one.
 *
 * Any iterable, so `export function* exclude()` and its async form are both just ways of writing
 * this — an array is not a requirement, only the most convenient shape.
 */
export type ExcludeHook = (
    context: HookContext
) => Iterable<string> | AsyncIterable<string> | Promise<Iterable<string> | AsyncIterable<string>>;

/** {@link ExcludeHook} as the CLI holds it: remote code, so its return value is unknown. */
type LoadedExclude = (context: HookContext) => unknown;

/**
 * The value as something to walk, or null when it is not a list of anything.
 *
 * A string is rejected on purpose: it is iterable, so excluding one would quietly come out as a
 * set of single characters instead of the obvious mistake it is. A generator object arrives here
 * as either kind of iterable, depending on which keyword the template used.
 */
function asIterable(value: unknown): Iterable<unknown> | AsyncIterable<unknown> | null {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return null;
    const candidate = value as Partial<Iterable<unknown> & AsyncIterable<unknown>>;
    if (typeof candidate[Symbol.iterator] === 'function') return candidate as Iterable<unknown>;
    if (typeof candidate[Symbol.asyncIterator] === 'function') return candidate as AsyncIterable<unknown>;
    return null;
}

export interface LoadOptions {
    vars: Record<string, string | undefined>;
    /** False for --no-hooks. */
    enabled: boolean;
    /** Says out loud that remote code was found, and whether it is about to run. */
    announce: (what: string) => void;
}

/**
 * The hooks one template ships. `Hooks.none` stands in for a template that ships none, so no
 * caller has to carry a nullable module around or ask whether there is anything to run.
 */
export class Hooks {
    /** A template that ships no hooks file: there is nothing to run and nothing to ask. */
    static readonly none = new Hooks({}, undefined, true);

    /**
     * A template whose hooks were switched off. Distinct from {@link none} because "the template
     * has no opinion on which files to install" and "we did not ask it" are different answers:
     * the second one has to be replayed from `.scaffold.json` instead of recomputed.
     */
    static readonly skipped = new Hooks({}, undefined, false);

    private constructor(
        private readonly module: HookModule,
        private readonly exclude: LoadedExclude | undefined,
        /** Whether the template's own code got a say. False only under --no-hooks. */
        readonly consulted: boolean
    ) {}

    /**
     * Import the template's hooks.
     *
     * `announce` fires only when a file is actually found, so the "remote code is about to run"
     * notice is never printed for a template that has no hooks.
     */
    static async load(repoDir: string, { vars, enabled, announce }: LoadOptions): Promise<Result<Hooks, string>> {
        const path = join(repoDir, HOOKS_FILE);
        if (!existsSync(path)) return Ok(Hooks.none);

        if (!enabled || vars[NO_HOOKS] === '1') {
            announce(`${HOOKS_FILE} skipped`);
            return Ok(Hooks.skipped);
        }
        announce(HOOKS_FILE);

        let loaded: unknown;
        try {
            loaded = (await import(pathToFileURL(path).href)) as unknown;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return Err(
                `${HOOKS_FILE} could not be loaded: ${message}\n\n` +
                    '  It must be plain ESM using only node: builtins — the CLI installs no dependencies\n' +
                    '  for it and never runs a package manager.'
            );
        }

        const exported = loaded as Record<string, unknown>;
        const module: HookModule = {};
        for (const name of HOOK_NAMES) {
            const value = exported[name];
            if (value === undefined) continue;
            if (typeof value !== 'function') {
                return Err(`${HOOKS_FILE} exports "${name}", but it is a ${typeof value} rather than a function.`);
            }
            module[name] = value as Hook;
        }

        const exclude = exported[EXCLUDE_HOOK];
        if (exclude !== undefined && typeof exclude !== 'function') {
            return Err(
                `${HOOKS_FILE} exports "${EXCLUDE_HOOK}", but it is a ${typeof exclude} rather than a function.`
            );
        }

        return Ok(new Hooks(module, exclude as LoadedExclude | undefined, true));
    }

    /**
     * Ask the template which of the files it ships do not belong in this project.
     *
     * Everything it hands back has to be a path the template actually has. The hooks file and
     * `template/` come out of the same commit, so a path that is not in there is a bug in the
     * template rather than a condition of the target repository — reporting it is the only way
     * the template author ever finds out, and it cannot strand a project the way a guess could.
     *
     * Any iterable will do, which makes `function*` and `async function*` ordinary ways to write
     * this hook. That is also why the walk is inside the try: a generator's body does not run
     * when it is called, so its throw arrives here rather than at the call above it.
     */
    async excluded(context: HookContext, candidates: readonly string[]): Promise<Result<ReadonlySet<string>, string>> {
        if (this.exclude === undefined) return Ok(new Set());

        const failed = (detail: string): Result<ReadonlySet<string>, string> =>
            Err(`hook "${EXCLUDE_HOOK}" of scaffold "${context.name}" ${detail}`);

        const known = new Set(candidates);
        const excluded = new Set<string>();

        try {
            const returned = await this.exclude(context.withFiles(candidates));

            // Excluding nothing is the common answer, so both ways of spelling it are allowed.
            if (returned === undefined || returned === null) return Ok(excluded);

            const paths = asIterable(returned);
            if (paths === null) return failed(`returned a ${typeof returned} rather than a list of paths.`);

            // `for await` drives a plain iterable too, so one loop covers both kinds of generator
            // and the array almost every hook actually returns.
            for await (const path of paths) {
                if (typeof path !== 'string') return failed(`listed a ${typeof path} rather than a path.`);
                if (!known.has(path)) {
                    return failed(
                        `excludes "${path}", which is not in ${TEMPLATE_DIR}/.\n\n` +
                            `  ${HOOKS_FILE} and ${TEMPLATE_DIR}/ ship from the same commit, so this is\n` +
                            '  a stale path in the template rather than something about this repository.'
                    );
                }
                excluded.add(path);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return Err(`hook "${EXCLUDE_HOOK}" of scaffold "${context.name}" failed: ${message}`);
        }

        return Ok(excluded);
    }

    /**
     * Runs one hook if the template defines it. The Ok value is whether it ran.
     *
     * A hook is remote code, so it signals failure the only way arbitrary code can — by throwing.
     * That throw is caught here and becomes an Err, which is the one place in the CLI where an
     * exception is still expected as input rather than produced as output.
     */
    async run(name: HookName, context: HookContext): Promise<Result<boolean, string>> {
        const hook = this.module[name];
        if (hook === undefined) return Ok(false);
        try {
            await hook(context);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return Err(`hook "${name}" of scaffold "${context.name}" failed: ${message}`);
        }
        return Ok(true);
    }
}
