import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Git, type Remote, type Vars } from './git.js';
import { neon } from './utils/neon.js';

/**
 * The package root, both when running from src/ (vitest) and from dist/ (published).
 * package.json sits next to those directories, never inside them.
 */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface PackageMeta {
    name: string;
    version: string;
    description: string;
}

export interface EnvOptions {
    pkg: PackageMeta;
    /** Default target repository, i.e. what --dir falls back to. */
    cwd: string;
    /** process.env, so the escape hatches stay injectable. */
    vars: Vars;
    log: (message: string) => void;
    error: (message: string) => void;
    /**
     * Where templates come from. `resolve` and `checkout` are separate because a commit is
     * immutable and a ref is not: resolving is a round trip every time, while a checkout of a
     * known commit is a cache hit forever after.
     */
    remote: Remote;
}

/**
 * Everything the commands touch that is not the target repository. Passing it around instead of
 * reaching for globals is what lets a test drive a real install against a throwaway repository
 * in-process, with its own remote and its own output sink.
 */
export class Env {
    readonly pkg: PackageMeta;
    readonly cwd: string;
    readonly vars: Vars;
    readonly remote: Remote;
    /**
     * Properties rather than methods: both sinks are handed to `Reporter.flush` as values, and a
     * detached method would arrive there without its `this`.
     */
    readonly log: (message: string) => void;
    readonly error: (message: string) => void;

    constructor(options: EnvOptions) {
        this.pkg = options.pkg;
        this.cwd = options.cwd;
        this.vars = options.vars;
        this.remote = options.remote;
        this.log = options.log;
        this.error = options.error;
    }

    /** An aside on stderr, dimmed: progress and warnings that must not reach the report. */
    note(message: string): void {
        this.error(neon.dim`${message}`);
    }

    /** What the real binary runs with. */
    static default(): Env {
        const error = (message: string): void => console.error(message);
        return new Env({
            pkg: readPackageMeta(PACKAGE_ROOT),
            cwd: process.cwd(),
            vars: process.env,
            log: (message) => console.log(message),
            error,
            // Progress on stderr, so the report on stdout stays machine-readable.
            remote: new Git({ vars: process.env, note: (message) => error(neon.dim`${message}`) }),
        });
    }
}

export function readPackageMeta(packageRoot: string): PackageMeta {
    const raw: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const pkg = raw as Partial<PackageMeta>;
    return {
        name: pkg.name ?? '@neoskop/scaffold',
        version: pkg.version ?? '0.0.0',
        description: pkg.description ?? '',
    };
}
