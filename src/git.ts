//
// Getting a template out of a git repository.
//
// Two operations, deliberately separate: `resolve` turns a ref into a commit with one cheap
// `ls-remote`, and `checkout` produces a tree for that commit. Splitting them lets `update`
// decide whether anything moved before paying for a clone, and lets it skip the second clone
// entirely when the incoming tree is also the merge base.
//
// Nothing is kept between runs. Every checkout is a fresh temp directory that its caller
// disposes of — see `Git.checkout` for why that is the right trade here.
//
// Neither ever throws: both hand back a Result. "The remote is unreachable" is something the
// user has to be told, not a stack trace, and — more importantly — a failed fetch must never be
// mistaken for an empty merge base, which would write conflict markers across a whole repository.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isFullSha, type RepoSpec } from './spec.js';
import { Err, Ok, type Result } from './utils/Result.js';

/** A network round trip that has not finished by now is a failure, not a wait. */
const FETCH_TIMEOUT_MS = 60_000;
/** Deepening and unshallowing are legitimately slow on a large repository. */
const DEEP_TIMEOUT_MS = 180_000;

/** Set to 1 to keep the CLI off the network entirely. Nothing is stored locally to fall back on. */
export const NO_FETCH = 'NEOSKOP_SCAFFOLD_NO_FETCH';

export type Vars = Record<string, string | undefined>;

/**
 * A template repository, checked out at one commit in a temp directory of its own.
 *
 * The directory is the repository root, so both `template/` and the hooks file are in it.
 */
export class Checkout {
    constructor(
        readonly dir: string,
        readonly commit: string,
        /** Not optional: every checkout is a temp directory, and nothing else reclaims it. */
        private readonly discard: () => void
    ) {}

    /** The commit as every message spells it. */
    get short(): string {
        return this.commit.slice(0, 8);
    }

    dispose(): void {
        this.discard();
    }
}

/** Where templates come from. An interface, so a test can hand the commands a different one. */
export interface Remote {
    /** A ref to a commit. Identity for a full hash — no round trip needed. */
    resolve(spec: RepoSpec): Result<string, string>;
    /** A checkout of exactly `commit`. */
    checkout(spec: RepoSpec, commit: string): Result<Checkout, string>;
}

export interface GitOptions {
    vars: Vars;
    /** Progress, printed only when the network is actually used. */
    note?: (message: string) => void;
}

// ---------------------------------------------------------------------------------------------
// Spawning git

/**
 * Config that is forced on every invocation. A template repository is remote input, and git
 * has several features that turn remote input into local code execution.
 */
function hardening(hooksDir: string): string[] {
    return [
        // A repo-controlled (or user-controlled) hooks path would run on checkout.
        '-c', `core.hooksPath=${hooksDir}`,
        // `ext::` and friends are arbitrary command execution. Deny everything, then allow three.
        '-c', 'protocol.allow=never',
        '-c', 'protocol.https.allow=always',
        '-c', 'protocol.ssh.allow=always',
        '-c', 'protocol.file.allow=always',
        // A submodule may name any transport at all, including the ones just denied.
        '-c', 'submodule.recurse=false',
        // A symlink in the tree is an arbitrary-write primitive once files are copied out.
        '-c', 'core.symlinks=false',
        '-c', 'advice.detachedHead=false',
        '-c', 'gc.auto=0',
    ];
}

function gitEnv(vars: Vars): Vars {
    const env: Vars = { ...vars };
    // These would redirect the clone's layout or seed it with hooks.
    delete env['GIT_TEMPLATE_DIR'];
    delete env['GIT_DIR'];
    delete env['GIT_WORK_TREE'];
    delete env['GIT_INDEX_FILE'];
    // Every invocation runs in a scratch directory (see `Scratch`), and this stops git walking
    // out of it in search of an enclosing repository whose config it would then honour.
    env['GIT_CEILING_DIRECTORIES'] = tmpdir();
    // Without this a private repository hangs on a username prompt forever, which in CI is
    // strictly worse than failing.
    env['GIT_TERMINAL_PROMPT'] = '0';
    env['GIT_ASKPASS'] = '';
    env['SSH_ASKPASS'] = '';
    env['DISPLAY'] = '';
    env['GIT_LFS_SKIP_SMUDGE'] = '1';
    env['GIT_ADVICE'] = '0';
    return env;
}

/**
 * Why one git invocation did not succeed.
 *
 * `reason` is the message to report and covers both cases, so a caller that only reports can
 * stop at it. The other two fields are for the callers that have to *classify* a failure: the
 * fetch ladder retries on an unadvertised object but never on a git that is not installed.
 */
export interface GitFailure {
    /** git could not be started, or was killed. There is no stderr worth interpreting. */
    fatal: boolean;
    reason: string;
    /** git's raw stderr. Empty when `fatal`. */
    stderr: string;
}

/**
 * A temp directory to run git in, plus an empty one to point `core.hooksPath` at.
 *
 * git always runs in `dir`, never in the target repository. Nothing here needs the project:
 * the work happens in a temp clone addressed with `-C`, and `ls-remote` needs no repository at
 * all. Running inside the target would only give its .git/config a vote — and a
 * `url.<x>.insteadOf` there would silently redirect a template spec to another repository,
 * whose hooks this tool then executes. Global config (credential helpers, proxies, org-wide
 * rewrites) still applies, because git reads that from $HOME wherever it runs.
 */
class Scratch {
    private constructor(
        readonly dir: string,
        private readonly hooksDir: string,
        private readonly options: GitOptions
    ) {}

    static create(prefix: string, options: GitOptions): Scratch {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        const hooksDir = join(dir, 'nohooks');
        mkdirSync(hooksDir, { recursive: true });
        return new Scratch(dir, hooksDir, options);
    }

    /** The Ok value is stdout — the only thing any caller wants from a git that succeeded. */
    run(args: readonly string[], timeout: number): Result<string, GitFailure> {
        const result = spawnSync('git', [...hardening(this.hooksDir), ...args], {
            cwd: this.dir,
            env: gitEnv(this.options.vars),
            encoding: 'utf8',
            timeout,
            killSignal: 'SIGKILL',
            maxBuffer: 8 * 1024 * 1024,
            // Never a shell: an argv is the only thing standing between a ref and a command line.
            shell: false,
            // Never `inherit`: git's progress output would shred the report on stdout.
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        const died = (reason: string): Result<string, GitFailure> => Err({ fatal: true, reason, stderr: '' });

        if (result.error) {
            const code = (result.error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') return died('git is not on PATH');
            if (code === 'ETIMEDOUT') return died(`git timed out after ${timeout / 1000}s`);
            return died(`git could not be run (${result.error.message})`);
        }
        if (result.signal === 'SIGKILL') return died(`git timed out after ${timeout / 1000}s`);

        const stderr = result.stderr ?? '';
        if (result.status !== 0) return Err({ fatal: false, reason: gitError(stderr), stderr });
        return Ok(result.stdout ?? '');
    }

    note(message: string): void {
        this.options.note?.(message);
    }

    dispose(): void {
        rmSync(this.dir, { recursive: true, force: true });
    }
}

/** git's own one-line diagnosis, which is far more useful than its exit code. */
export function gitError(stderr: string): string {
    const lines = stderr
        .split('\n')
        .map((line) => line.replace(/^(fatal|error|warning|remote|hint):\s*/i, '').trim())
        .filter((line) => line !== '' && !/^(Cloning into|Note: switching to|You are in 'detached HEAD')/.test(line));

    const first = lines[0];
    if (first === undefined) return 'git failed';

    // The three failures people actually hit deserve a sentence rather than git's phrasing.
    const all = lines.join(' ');
    if (/could not read Username|Authentication failed|Permission denied \(publickey\)|terminal prompts disabled/i.test(all)) {
        return 'no credentials for that remote — if the template repository is private, set up an SSH key or a credential helper';
    }
    if (/Remote branch .* not found|couldn't find remote ref|not found in upstream/i.test(all)) {
        return 'the remote has no such ref';
    }
    return first;
}

/** The server refused to serve a commit that no ref points at. Common outside GitHub. */
export function isUnadvertised(stderr: string): boolean {
    return /unadvertised object|not our ref|allow.*sha1|does not support.*want|Server does not allow/i.test(stderr);
}

// ---------------------------------------------------------------------------------------------
// Fetching

/**
 * One repository being pulled into a working tree, and the ladder of ways to get a commit there.
 *
 * A single-commit fetch is the cheap path, but it only works when the server sets
 * `uploadpack.allowReachableSHA1InWant` — GitLab on-prem, Gitea and Azure DevOps commonly do
 * not, and even GitHub refuses a commit no ref can reach. So the ladder below is a normal code
 * path, not an edge case: deepen a few times, then fall back to a blobless full history, then
 * to a plain clone.
 */
class Clone {
    /** The repository itself, inside the scratch directory. */
    readonly work: string;

    constructor(
        private readonly scratch: Scratch,
        private readonly spec: RepoSpec,
        private readonly commit: string
    ) {
        this.work = join(scratch.dir, 'repo');
    }

    /**
     * Get `commit` into the working tree.
     *
     * A `fatal` failure ends the ladder wherever it appears — a git that is not installed will
     * not become installed by being asked again — while an ordinary non-zero exit is what the
     * next rung is for.
     */
    obtain(): Result<void, string> {
        mkdirSync(this.work, { recursive: true });

        const init = this.scratch.run(['init', '--quiet', '--template=', this.work], FETCH_TIMEOUT_MS);
        if (init.isErr()) return Err(init.err.reason);

        const remote = this.git(['remote', 'add', 'origin', this.spec.url], FETCH_TIMEOUT_MS);
        if (remote.isErr()) return Err(remote.err.reason);

        const direct = this.fetch(['--depth', '1', '--end-of-options', 'origin', this.commit], FETCH_TIMEOUT_MS);
        if (direct.isOk()) return this.checkout('FETCH_HEAD');
        if (direct.err.fatal) return Err(direct.err.reason);
        if (!isUnadvertised(direct.err.stderr)) return Err(direct.err.reason);

        // 1. Deepen the default branch in a few bounded steps. A recorded merge base was a tip
        //    not long ago, so this almost always finds it without transferring the whole history.
        this.scratch.note(`${this.spec.repo} will not serve a single commit — deepening`);
        for (const depth of ['50', '200', '1000']) {
            const deepen = this.fetch(['--depth', depth, 'origin'], DEEP_TIMEOUT_MS);
            if (deepen.isErr()) {
                if (deepen.err.fatal) return Err(deepen.err.reason);
                break;
            }
            if (this.has()) return this.checkout(this.commit);
        }

        // 2. Full history, but no file contents until something asks for them.
        const blobless = this.git(
            ['fetch', '--no-tags', '--quiet', '--unshallow', '--filter=blob:none', 'origin'],
            DEEP_TIMEOUT_MS
        );
        if (blobless.isOk() && this.has()) return this.checkout(this.commit);

        // 3. Everything.
        this.scratch.note(`deep-cloning ${this.spec.repo} — the server will not serve a partial history`);
        const full = this.git(['fetch', '--no-tags', '--quiet', '--unshallow', 'origin'], DEEP_TIMEOUT_MS);
        if (full.isErr() && full.err.fatal) return Err(full.err.reason);
        if (full.isOk() && this.has()) return this.checkout(this.commit);

        return Err(
            `${this.spec.repo} will not serve commit ${this.commit.slice(0, 8)}, and fetching the full history did not find it either`
        );
    }

    /** null rather than an Err: there is no reason here worth reporting, only "no usable HEAD". */
    head(): string | null {
        const result = this.git(['rev-parse', '--verify', 'HEAD^{commit}'], FETCH_TIMEOUT_MS);
        if (result.isErr()) return null;
        const value = result.value.trim();
        return isFullSha(value) ? value : null;
    }

    /** git, in the working tree rather than in the scratch directory around it. */
    private git(args: readonly string[], timeout: number): Result<string, GitFailure> {
        return this.scratch.run(['-C', this.work, ...args], timeout);
    }

    private fetch(args: readonly string[], timeout: number): Result<string, GitFailure> {
        return this.git(['fetch', '--no-tags', '--no-recurse-submodules', '--quiet', ...args], timeout);
    }

    private has(): boolean {
        return this.git(['cat-file', '-e', `${this.commit}^{commit}`], FETCH_TIMEOUT_MS).isOk();
    }

    /** `rev` is only ever `FETCH_HEAD` or a hex commit that {@link parseSpec} already validated. */
    private checkout(rev: string): Result<void, string> {
        return this.git(['checkout', '--quiet', '--detach', rev], DEEP_TIMEOUT_MS)
            .map(() => undefined)
            .mapErr((failure) => failure.reason);
    }
}

// ---------------------------------------------------------------------------------------------

/** The real remote, as {@link Env.default} wires it. */
export class Git implements Remote {
    constructor(private readonly options: GitOptions) {}

    /**
     * Turn a spec's ref into a commit. One `ls-remote`, or none at all when the spec already
     * names a full hash.
     */
    resolve(spec: RepoSpec): Result<string, string> {
        const { ref } = spec;
        if (ref.kind === 'commit' && isFullSha(ref.value)) return Ok(ref.value);

        if (this.offline) return Err(`resolving refs is disabled (${NO_FETCH}=1)`);

        const scratch = Scratch.create('neoskop-scaffold-ls-', this.options);
        try {
            const args = ['ls-remote', '--end-of-options', spec.url];
            if (ref.kind !== 'default') args.push(ref.value);

            return scratch
                .run(args, FETCH_TIMEOUT_MS)
                .mapErr((failure) => failure.reason)
                .andThen((stdout): Result<string, string> => {
                    const commit = pickRef(stdout, spec);
                    if (commit !== null) return Ok(commit);
                    // A short hash cannot be resolved by ls-remote; the fetch has to find it.
                    if (ref.kind === 'commit') return Ok(ref.value);
                    const what = ref.kind === 'default' ? 'default branch' : `ref named "${ref.value}"`;
                    return Err(`${spec.repo} has no ${what}`);
                });
        } finally {
            scratch.dispose();
        }
    }

    /**
     * A checkout of exactly `commit`, in a fresh temp directory the caller must `dispose()`.
     *
     * `.git` is dropped afterwards: what is wanted is a tree, and leaving a repository behind
     * would only invite something later to fetch into it.
     *
     * Nothing is kept between runs. A template checkout is a few kilobytes of text that a
     * shallow clone reproduces in well under a second, and a cache of remote code — which is
     * what a template is, hooks included — is a thing that has to be invalidated,
     * garbage-collected, kept safe against concurrent writers, and audited. Fetching every time
     * costs a round trip and removes all four problems.
     */
    checkout(spec: RepoSpec, commit: string): Result<Checkout, string> {
        if (this.offline) return Err(`fetching is disabled (${NO_FETCH}=1)`);

        const scratch = Scratch.create('neoskop-scaffold-', this.options);
        const clone = new Clone(scratch, spec, commit);

        scratch.note(`fetching ${spec.repo} at ${commit.slice(0, 8)}`);

        // Every failure past this point has to dispose of the scratch directory on the way out:
        // an Err carries no `dispose`, so nothing downstream can reclaim it.
        const failed = (reason: string): Result<Checkout, string> => {
            scratch.dispose();
            return Err(reason);
        };

        const obtained = clone.obtain();
        if (obtained.isErr()) return failed(obtained.err);

        const actual = clone.head();
        if (actual === null) return failed('git did not produce a usable checkout');
        if (isFullSha(commit) && actual !== commit) {
            return failed(`expected ${commit.slice(0, 8)} but the remote served ${actual.slice(0, 8)}`);
        }

        rmSync(join(clone.work, '.git'), { recursive: true, force: true });

        return Ok(new Checkout(clone.work, actual, () => scratch.dispose()));
    }

    private get offline(): boolean {
        return this.options.vars[NO_FETCH] === '1';
    }
}

/**
 * Pick the commit out of `ls-remote` output. A tag is preferred through its peeled `^{}` line,
 * which is the commit the tag points at rather than the tag object itself.
 */
function pickRef(stdout: string, spec: RepoSpec): string | null {
    const rows = stdout
        .split('\n')
        .map((line) => line.split('\t'))
        .filter((parts): parts is [string, string] => parts.length === 2 && FULL_SHA_LINE.test(parts[0] as string))
        .map(([sha, name]) => ({ sha, name }));

    if (spec.ref.kind === 'default') {
        return rows.find((row) => row.name === 'HEAD')?.sha ?? null;
    }

    const value = spec.ref.value;
    const wanted =
        spec.ref.kind === 'tag'
            ? [`refs/tags/${value}^{}`, `refs/tags/${value}`]
            : spec.ref.kind === 'branch'
              ? [`refs/heads/${value}`]
              : [`refs/tags/${value}^{}`, `refs/heads/${value}`, `refs/tags/${value}`, value];

    for (const name of wanted) {
        const hit = rows.find((row) => row.name === name);
        if (hit !== undefined) return hit.sha;
    }
    return null;
}

const FULL_SHA_LINE = /^[0-9a-f]{40}$/;
