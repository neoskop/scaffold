//
// The part init and update do identically: get a checkout, walk its template, load its hooks,
// and hand the commands one object that owns all three — including the temp directory nothing
// else will reclaim.

import type { Env } from '../env.js';
import type { Checkout } from '../git.js';
import { HookContext, Hooks } from '../hooks.js';
import type { Reporter } from '../report.js';
import type { RepoSpec } from '../spec.js';
import { Template } from '../template.js';
import { Err, Ok, type Result } from '../utils/Result.js';

export interface OpenOptions {
    /** Skip the resolve when the caller already knows the commit it wants. */
    commit?: string;
    /** False for --no-hooks. */
    hooks: boolean;
}

export interface ContextOptions {
    root: string;
    name: string;
    spec: RepoSpec;
    previousCommit: string | null;
    check: boolean;
    reporter: Reporter;
}

/** A template repository, fetched: what it installs, the hooks beside it, and the checkout. */
export class Source {
    private constructor(
        private readonly checkout: Checkout,
        readonly template: Template,
        readonly hooks: Hooks
    ) {}

    /**
     * Resolve a spec to a commit, check it out, and read what it installs.
     *
     * Every failure past the checkout disposes of it on the way out: an Err carries no
     * `dispose`, so nothing downstream could reclaim the temp directory.
     */
    static async open(env: Env, spec: RepoSpec, options: OpenOptions): Promise<Result<Source, string>> {
        const at = options.commit === undefined ? resolveCommit(env, spec) : Ok(options.commit);
        const got = at.andThen((commit) =>
            env.remote.checkout(spec, commit).mapErr((reason) => `cannot fetch ${spec.repo} (${reason}).`)
        );
        if (got.isErr()) return got.castErr();
        const checkout = got.value;

        const template = Template.walk(checkout.dir);
        if (template.isErr()) {
            checkout.dispose();
            return Err(`${spec.repo} at ${checkout.short} is not a scaffold: ${template.err}.`);
        }

        // Announced rather than silent: this is where remote code is about to be imported.
        const hooks = await Hooks.load(checkout.dir, {
            vars: env.vars,
            enabled: options.hooks,
            announce: (what) => env.note(`hooks  ${what} from ${spec.repo}#${checkout.short}`),
        });
        if (hooks.isErr()) {
            checkout.dispose();
            return hooks.castErr();
        }

        return Ok(new Source(checkout, template.value, hooks.value));
    }

    get commit(): string {
        return this.checkout.commit;
    }

    /** The commit as every message spells it. */
    get short(): string {
        return this.checkout.short;
    }

    /** What the hooks get. `files` is filled in afterwards, by {@link HookContext.withFiles}. */
    context({ root, name, spec, previousCommit, check, reporter }: ContextOptions): HookContext {
        return new HookContext({
            cwd: root,
            templateDir: this.template.dir,
            repoDir: this.checkout.dir,
            name,
            ref: spec.ref,
            commit: this.commit,
            previousCommit,
            check,
            files: [],
            log: (kind, path, detail) => reporter.record(kind, path, detail),
        });
    }

    /** Removes the temp checkout. Nothing else will. */
    dispose(): void {
        this.checkout.dispose();
    }
}

export function resolveCommit(env: Env, spec: RepoSpec): Result<string, string> {
    return env.remote.resolve(spec).mapErr((reason) => `cannot resolve ${describeSpec(spec)} (${reason}).`);
}

export function describeSpec(spec: RepoSpec): string {
    return spec.ref.kind === 'default' ? spec.repo : `${spec.repo} at ${spec.ref.value}`;
}
