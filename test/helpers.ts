import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { run } from '../src/cli.js';
import { Env } from '../src/env.js';
import { Git, type Remote } from '../src/git.js';
import type { ScaffoldEntry } from '../src/state.js';

const scratch: string[] = [];

/** A temp directory, removed again by `cleanupScratch()`. */
export function scratchDir(prefix = 'work'): string {
    const dir = mkdtempSync(join(tmpdir(), `neoskop-scaffold-${prefix}-`));
    scratch.push(dir);
    return dir;
}

export function cleanupScratch(): void {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
}

export interface Fixture {
    /** Absolute path of the template repository. */
    root: string;
    /** What a user would type to install it: `file:///…`. */
    spec: string;
    /** Writes files (null deletes), commits, and returns the new commit hash. */
    commit: (files: Record<string, string | null>, message?: string) => string;
    /** Writes scaffold.hooks.mjs at the repo ROOT — never inside template/ — and commits. */
    hooks: (source: string) => string;
    tag: (name: string) => void;
    branch: (name: string) => void;
    head: () => string;
    /** e.g. `uploadpack.allowReachableSHA1InWant true`, to exercise the fetch fallbacks. */
    config: (key: string, value: string) => void;
}

/**
 * A throwaway repository laid out the way a template repository is: `template/` mirroring the
 * target tree, optionally a hooks file beside it. Everything is committed, because a clone only
 * ever sees commits — which is the difference between this and an in-memory fake.
 */
export function templateRepo(files: Record<string, string> = {}, prefix = 'tpl'): Fixture {
    const root = join(scratchDir(prefix), 'template-repo');
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-b', 'main', '--quiet');

    const fixture: Fixture = {
        root,
        spec: pathToFileURL(root).href,
        commit: (changes, message = 'change') => {
            for (const [path, content] of Object.entries(changes)) {
                const absolute = join(root, path);
                if (content === null) {
                    if (existsSync(absolute)) unlinkSync(absolute);
                    continue;
                }
                mkdirSync(dirname(absolute), { recursive: true });
                writeFileSync(absolute, content);
            }
            git(root, 'add', '-A');
            git(root, 'commit', '--quiet', '--allow-empty', '-m', message);
            return git(root, 'rev-parse', 'HEAD');
        },
        hooks: (source) => fixture.commit({ 'scaffold.hooks.mjs': source }, 'hooks'),
        tag: (name) => void git(root, 'tag', name),
        branch: (name) => void git(root, 'branch', name),
        head: () => git(root, 'rev-parse', 'HEAD'),
        config: (key, value) => void git(root, 'config', key, value),
    };

    fixture.commit(prefixTemplate(files), 'initial');
    return fixture;
}

/** Anything not already addressed at the repo root goes under `template/`. */
function prefixTemplate(files: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) {
        out[path.startsWith('template/') || path === 'scaffold.hooks.mjs' ? path : `template/${path}`] = content;
    }
    return out;
}

/** A small payload that stands in for the devcontainer one, so merge tests read naturally. */
export function baselineTemplate(): Record<string, string> {
    return {
        '.devcontainer/Dockerfile': ['FROM node:24', 'RUN echo base', ''].join('\n'),
        '.devcontainer/devcontainer.json': '{\n    "name": "sandbox"\n}\n',
        '.devcontainer/proxy/allowlist.txt': ['registry.npmjs.org', '.github.com', '', '# --- Project', ''].join('\n'),
        '.pnpmfile.mjs': 'export default {};\n',
    };
}

export interface RepoOptions {
    /** package.json of the target repo. `null` writes none at all. */
    packageJson?: Record<string, unknown> | null;
    /** Skip `git init`, to exercise the precondition. */
    git?: boolean;
    vars?: Record<string, string | undefined>;
    /** Replaces the real remote: to force a failure, or to prove it is never consulted. */
    remote?: Remote;
}

export interface Repo {
    /** Absolute path of the throwaway target repository. */
    root: string;
    /** Its private clone cache, so nothing leaks between tests. */
    cacheHome: string;
    /** Runs the CLI in-process against `root`. */
    run: (...argv: string[]) => Promise<number>;
    /** Everything the last run printed, stdout and stderr together. */
    output: () => string;
    read: (relative: string) => string;
    write: (relative: string, content: string) => void;
    remove: (relative: string) => void;
    exists: (relative: string) => boolean;
    /** In-place search and replace, so tests can provoke a real merge collision. */
    patch: (relative: string, from: string | RegExp, to: string) => void;
    /** The .scaffold.json as it was written, read straight back off disk. */
    state: () => { scaffolds: Record<string, ScaffoldEntry | undefined>; raw: Record<string, unknown> };
}

export function createRepo({ packageJson, git: withGit = true, vars, remote }: RepoOptions = {}): Repo {
    const root = join(scratchDir('repo'), 'target');
    mkdirSync(root, { recursive: true });
    if (withGit) spawnSync('git', ['init', '-b', 'main', '--quiet'], { cwd: root });

    if (packageJson !== null) {
        const contents = packageJson ?? { name: 'target-fixture', packageManager: 'pnpm@11.19.0' };
        writeFileSync(join(root, 'package.json'), `${JSON.stringify(contents, null, 2)}\n`);
    }

    const cacheHome = scratchDir('cache');
    let output = '';

    const repo: Repo = {
        root,
        cacheHome,
        run: (...argv) => {
            output = '';
            const sink = (message: string): void => {
                output += `${message}\n`;
            };
            const env: Record<string, string | undefined> = {
                ...process.env,
                ...vars,
            };
            const base = new Env({
                pkg: { name: '@neoskop/scaffold', version: '0.0.0-test', description: 'test fixture' },
                cwd: root,
                vars: env,
                log: sink,
                error: sink,
                remote: remote ?? new Git({ vars: env }),
            });
            return run(argv, base);
        },
        output: () => output,
        read: (relative) => readFileSync(join(root, relative), 'utf8'),
        write: (relative, content) => {
            mkdirSync(dirname(join(root, relative)), { recursive: true });
            writeFileSync(join(root, relative), content);
        },
        remove: (relative) => unlinkSync(join(root, relative)),
        exists: (relative) => existsSync(join(root, relative)),
        patch: (relative, from, to) => {
            const path = join(root, relative);
            const before = readFileSync(path, 'utf8');
            const after = before.replace(from, to);
            if (after === before) throw new Error(`patch did not match in ${relative}: ${String(from)}`);
            writeFileSync(path, after);
        },
        state: () => {
            const raw = JSON.parse(readFileSync(join(root, '.scaffold.json'), 'utf8')) as Record<string, unknown>;
            return { scaffolds: (raw['scaffolds'] ?? {}) as Record<string, ScaffoldEntry | undefined>, raw };
        },
    };
    return repo;
}

/** Every file under `root` and its contents, for "nothing was written" assertions. */
export function snapshot(root: string): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (dir: string, prefix: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '.git') continue;
            const path = join(dir, entry.name);
            const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) walk(path, relative);
            else files[relative] = readFileSync(path, 'utf8');
        }
    };
    walk(root, '');
    return files;
}

/** Resolve conflict markers the way a human keeping their own version would. */
export function resolveKeepingLocal(text: string): string {
    const kept: string[] = [];
    let inTheirs = false;
    for (const line of text.split('\n')) {
        if (line.startsWith('<<<<<<< ')) continue;
        if (line.startsWith('|||||||')) {
            inTheirs = true;
            continue;
        }
        if (line.startsWith('>>>>>>> ')) {
            inTheirs = false;
            continue;
        }
        if (!inTheirs) kept.push(line);
    }
    return kept.join('\n');
}
