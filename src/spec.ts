//
// Where a template comes from.
//
// The grammar dispatches on the *form* of the whole string before it looks for a ref, because
// the separators overlap: `git@github.com:org/repo.git` already contains an `@`, and a branch
// name may contain `/`. Classifying first means `@` and `/` are ref separators only in the
// `org/repo` shorthand, and a fully qualified URL or a path takes `#<ref>` and nothing else.
//
// Everything here runs before a string reaches an argv, so it doubles as the input validation
// for `git.ts`: a ref that starts with `-` is an option, and `ext::` is arbitrary command
// execution by git itself. Both are refused here rather than escaped later.

import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Err, Ok, type Result } from './utils/Result.js';

export type RefKind = 'default' | 'branch' | 'tag' | 'commit' | 'rev';

export interface Ref {
    kind: RefKind;
    /** Empty for `default`. Verbatim, so a branch may contain `/`. */
    value: string;
}

export interface RepoSpec {
    /** Canonical identity with the ref stripped. This is what a state entry records. */
    repo: string;
    /** What git is handed: an https/ssh URL, or a file:// URL for a local path. */
    url: string;
    /** Default scaffold name: the repo's basename without `.git`. */
    name: string;
    ref: Ref;
    /** Local paths are the only form allowed to point at something that is not a remote. */
    local: boolean;
}

/** One path segment of a GitHub shorthand. Alphanumeric at both ends, so `..` cannot appear. */
const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * A ref, by allowlist. Refuses a leading `-` (an option to whatever git command it reaches),
 * `..` and `//` (invalid to git anyway, and a traversal risk once it becomes a cache key),
 * and every character git itself rejects — `~ ^ : ? * [ \`, whitespace and control characters
 * are simply not in the class.
 */
const REF = /^(?!-)(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,255}$/;

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{7,40}$/;

const URL_FORM = /^(?:git@|ssh:\/\/|https:\/\/|http:\/\/|git:\/\/)/;
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/** `git@host:org/repo(.git)` — the scp-like syntax, which is not a URL and cannot be parsed as one. */
const SCP_LIKE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]{1,253}):(.+)$/;

export function isFullSha(value: string): boolean {
    return FULL_SHA.test(value);
}

/** A `#`-suffixed rev on a form that has no other ref syntax. */
function splitHash(input: string): Result<{ head: string; ref: Ref }, string> {
    const at = input.lastIndexOf('#');
    if (at === -1) return Ok({ head: input, ref: { kind: 'default', value: '' } as Ref });
    const head = input.slice(0, at);
    const value = input.slice(at + 1);
    if (head === '') return Err(`"${input}" has no repository before the "#".`);
    return classify(value, input).map((ref) => ({ head, ref }));
}

/**
 * A `#<ref>` is deliberately not assumed to be a commit: `git@host:o/r.git#main` has to work,
 * and only a resolve can tell a branch from a tag anyway. A full hash is recognised because it
 * needs no round trip.
 */
function classify(value: string, input: string): Result<Ref, string> {
    if (value === '') return Err(`"${input}" has an empty ref after the "#".`);
    if (SHA.test(value) && value.length >= 7) return Ok<Ref>({ kind: 'commit', value });
    if (!REF.test(value)) return Err(refRejection(value, input));
    return Ok<Ref>({ kind: 'rev', value });
}

function refRejection(value: string, input: string): string {
    const why = value.startsWith('-')
        ? 'a ref may not start with "-" — git would read it as an option'
        : 'only letters, digits and . _ - / are allowed, and not ".." or "//"';
    return `"${value}" is not a usable git ref (in "${input}"): ${why}.`;
}

function repoName(identity: string): string {
    const last = identity.split('/').pop() ?? identity;
    return last.replace(/\.git$/, '') || identity;
}

export interface ParseOptions {
    /** What a relative local path is resolved against — the target repository, not the CLI's cwd. */
    cwd: string;
}

/**
 * Parse a repository spec. An Err carries the grammar in its message, so a typo never becomes
 * an argv.
 */
export function parseSpec(input: string, { cwd }: ParseOptions): Result<RepoSpec, string> {
    const trimmed = input.trim();
    if (trimmed === '') return Err(`a repository is required.\n\n${GRAMMAR}`);

    // 1. `ext::sh -c …` makes git run an arbitrary command as its transport. No spelling of a
    //    template source needs a `::`, so the whole class goes before anything else is parsed.
    if (trimmed.includes('::')) {
        return Err(
            `"${trimmed}" uses a git transport helper ("::"), which can run arbitrary commands.\n\n` +
                '  Only https, ssh and local paths are accepted.'
        );
    }

    if (isLocalForm(trimmed)) return parseLocal(trimmed, cwd);
    if (URL_FORM.test(trimmed)) return parseUrl(trimmed);
    return parseShorthand(trimmed, cwd);
}

function isLocalForm(input: string): boolean {
    return (
        input.startsWith('.') ||
        input.startsWith('/') ||
        input.startsWith('~') ||
        input.startsWith('file://') ||
        WINDOWS_PATH.test(input)
    );
}

/**
 * A local path is always handed to git as `file://`. A bare path triggers git's `--local`
 * optimization: it hardlinks into the source object store and inherits its alternates, which
 * makes the "clone" a view of the original rather than a snapshot — and silently ignores
 * `--depth`. `file://` forces the real transport.
 */
function parseLocal(input: string, cwd: string): Result<RepoSpec, string> {
    return splitHash(input).andThen(({ head, ref }): Result<RepoSpec, string> => {
        if (head.startsWith('~')) {
            return Err(`"${head}" starts with "~", which only a shell expands. Write the path out in full.`);
        }

        // Resolved against `cwd` — the target repository — and not against `process.cwd()`, which
        // is somewhere else entirely under `--dir`. Both `path.relative` and `pathToFileURL`
        // anchor a relative path to `process.cwd()`, so neither may be handed the typed one.
        const absolute = head.startsWith('file://') ? fileURLToPath(head) : resolve(cwd, head);

        if (!existsSync(absolute)) return Err(`${head} does not exist.`);

        return Ok({
            repo: localIdentity(cwd, absolute),
            url: pathToFileURL(absolute).href,
            name: repoName(absolute.replace(/[/\\]+$/, '')),
            ref,
            local: true,
        });
    });
}

/**
 * How a local repository is recorded: relative to the target repository, so that a project which
 * scaffolds itself, or a template checked out beside the project that uses it, resolves to the
 * same pair of directories on every machine — an absolute path in a committed `.scaffold.json`
 * only ever names one developer's disk.
 *
 * Always `.`-prefixed and always with `/` separators. The prefix is what tells the recorded path
 * from an `org/repo` shorthand when {@link specFromState} reads it back, since `templates/tpl` is
 * a legal spelling of both; the separators keep a state file written on Windows readable on a
 * posix checkout, which is the whole point of recording it relative.
 */
function localIdentity(cwd: string, absolute: string): string {
    const path = relative(cwd, absolute);
    if (path === '') return '.';
    // Different Windows drives: there is no path from one to the other to record.
    if (isAbsolute(path)) return absolute;
    const posix = path.split(sep).join('/');
    return posix.startsWith('.') ? posix : `./${posix}`;
}

function parseUrl(input: string): Result<RepoSpec, string> {
    return splitHash(input).andThen(({ head, ref }): Result<RepoSpec, string> => {
        if (head.startsWith('http://') || head.startsWith('git://')) {
            const scheme = head.startsWith('http://') ? 'http' : 'git';
            return Err(
                `"${head}" uses ${scheme}://, which is unauthenticated and can be tampered with in transit.\n\n` +
                    '  Use https:// or ssh:// instead.'
            );
        }

        const scp = SCP_LIKE.exec(head);
        if (scp !== null) {
            const path = scp[3] as string;
            return checkPath(path, head).map(() => ({ repo: head, url: head, name: repoName(path), ref, local: false }));
        }

        let url: URL;
        try {
            url = new URL(head);
        } catch {
            return Err(`"${head}" is not a valid URL.\n\n${GRAMMAR}`);
        }
        if (url.username !== '' || url.password !== '') {
            return Err(`"${head}" embeds credentials. Use a credential helper or an SSH key instead.`);
        }
        return checkPath(url.pathname.replace(/^\//, ''), head).map(() => ({
            repo: head,
            url: head,
            name: repoName(url.pathname),
            ref,
            local: false,
        }));
    });
}

function checkPath(path: string, input: string): Result<void, string> {
    const segments = path.replace(/\.git$/, '').split('/').filter((segment) => segment !== '');
    if (segments.length === 0) return Err(`"${input}" names no repository path.`);
    for (const segment of segments) {
        if (!SEGMENT.test(segment)) return Err(`"${segment}" is not a usable path segment (in "${input}").`);
    }
    return Ok<void>(undefined);
}

/**
 * `org/repo` plus an optional ref, where the character right after the second segment picks
 * the kind and everything after it is the value verbatim — so `org/repo/feature/x` is branch
 * `feature/x` and not an ambiguity.
 *
 * The shorthand resolves to `git@github.com:org/repo.git`, so a private template works from
 * the same SSH key as everything else; `https://github.com/…` is still spellable in full.
 */
function parseShorthand(input: string, cwd: string): Result<RepoSpec, string> {
    const first = input.indexOf('/');
    if (first === -1) return Err(unknownForm(input, cwd));

    const owner = input.slice(0, first);
    const rest = input.slice(first + 1);
    const end = rest.search(/[/@#]/);
    const repo = end === -1 ? rest : rest.slice(0, end);

    if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return Err(unknownForm(input, cwd));

    let ref: Ref = { kind: 'default', value: '' };
    if (end !== -1) {
        const separator = rest[end] as string;
        const value = rest.slice(end + 1);
        if (value === '') return Err(`"${input}" ends in "${separator}" with no ref after it.`);
        if (separator === '#') {
            if (!SHA.test(value)) return Err(`"${value}" is not a commit hash (in "${input}"). Use @tag or /branch.`);
            ref = { kind: 'commit', value };
        } else {
            if (!REF.test(value)) return Err(refRejection(value, input));
            ref = { kind: separator === '@' ? 'tag' : 'branch', value };
        }
    }

    const identity = `${owner}/${repo}`;
    return Ok({
        repo: identity,
        url: `git@github.com:${identity}.git`,
        name: repo,
        ref,
        local: false,
    });
}

function unknownForm(input: string, cwd: string): string {
    const asPath = resolve(cwd, input);
    const hint = existsSync(asPath) ? `\n\n  "${input}" is a directory here — did you mean ./${input}?` : '';
    return `"${input}" is not a repository spec.${hint}\n\n${GRAMMAR}`;
}

const GRAMMAR = [
    '  org/repo            GitHub, default branch',
    '  org/repo/branch     GitHub, a branch (may contain slashes)',
    '  org/repo@tag        GitHub, a tag',
    '  org/repo#hash       GitHub, a commit',
    '  git@host:org/repo   any SSH remote          (add #<ref> to pin)',
    '  https://host/o/r    any HTTPS remote        (add #<ref> to pin)',
    '  ./path/to/repo      a local git repository  (add #<ref> to pin)',
].join('\n');

/** `--ref`: a bare ref with no repository around it. */
export function parseRefFlag(value: string): Result<Ref, string> {
    return classify(value, value);
}

export function withRef(spec: RepoSpec, ref: Ref): RepoSpec {
    return { ...spec, ref };
}

/**
 * Rebuild a spec from what a state entry recorded, without re-parsing user syntax — the
 * identity was already canonical when it was written.
 *
 * A local path is resolved against `cwd`, the target repository: that is what {@link localIdentity}
 * recorded it relative to. Older state files hold an absolute path, which `resolve` passes through
 * unchanged, so both spellings keep working.
 */
export function specFromState(repo: string, ref: Ref, cwd: string): RepoSpec {
    if (isAbsolute(repo) || repo.startsWith('.')) {
        const absolute = resolve(cwd, repo);
        return { repo, url: pathToFileURL(absolute).href, name: repoName(absolute), ref, local: true };
    }
    if (URL_FORM.test(repo)) {
        const scp = SCP_LIKE.exec(repo);
        const path = scp ? (scp[3] as string) : new URL(repo).pathname;
        return { repo, url: repo, name: repoName(path), ref, local: false };
    }
    return { repo, url: `git@github.com:${repo}.git`, name: repoName(repo), ref, local: false };
}
