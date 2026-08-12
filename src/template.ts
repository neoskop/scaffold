//
// What a template repository actually installs.
//
// `template/` mirrors the target tree: `template/.devcontainer/Dockerfile` lands at
// `.devcontainer/Dockerfile`, `template/.pnpmfile.mjs` at the repository root. A recursive walk
// replaces the hand-maintained path table the devcontainer installer used to carry, and the
// executable bit comes from what git checked out rather than from a column in that table.

import { existsSync, lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { Err, Ok, type Result } from './utils/Result.js';

/** The directory inside a template repository whose contents get installed. */
export const TEMPLATE_DIR = 'template';

/** One file the template installs. */
export class TemplateEntry {
    constructor(
        /** POSIX-relative inside template/, and identically the path in the target repository. */
        readonly path: string,
        /** Absolute source path in the checkout. */
        readonly source: string,
        readonly mode: number
    ) {}

    read(): Content {
        return Content.read(this.source);
    }
}

/** The `template/` directory of one checkout: every file it installs, indexed by target path. */
export class Template {
    private readonly index: ReadonlyMap<string, TemplateEntry>;

    private constructor(
        /** Absolute path of the checkout's `template/`. */
        readonly dir: string,
        readonly entries: readonly TemplateEntry[],
        /** Symlinks, sockets, fifos: skipped rather than installed, and reported. */
        readonly skipped: readonly string[]
    ) {
        this.index = new Map(entries.map((entry) => [entry.path, entry]));
    }

    /**
     * Walk `<checkoutDir>/template`.
     *
     * A hand-written table could not contain a symlink; a walk can. `template/x -> /etc/passwd`
     * would otherwise be read through and, on the way back, written through — so every entry that
     * is not a regular file is skipped and surfaced instead.
     *
     * An Err is "this checkout is not a scaffold", which every caller turns into a message naming
     * the repository it came from.
     */
    static walk(checkoutDir: string): Result<Template, string> {
        const dir = join(checkoutDir, TEMPLATE_DIR);

        let root: Stats;
        try {
            root = lstatSync(dir);
        } catch {
            return Err(`no ${TEMPLATE_DIR}/ directory in the template repository`);
        }
        if (!root.isDirectory()) return Err(`${TEMPLATE_DIR} is not a directory`);

        const entries: TemplateEntry[] = [];
        const skipped: string[] = [];

        const walk = (absolute: string): void => {
            for (const item of readdirSync(absolute, { withFileTypes: true })) {
                // A template repository's own git metadata is never part of the payload.
                if (item.name === '.git') continue;
                const child = join(absolute, item.name);
                const stat = lstatSync(child);

                if (stat.isDirectory()) {
                    walk(child);
                    continue;
                }
                const path = relative(dir, child).split(sep).join('/');
                if (!stat.isFile()) {
                    skipped.push(path);
                    continue;
                }
                // Only the owner-execute bit survives; the rest is the umask's business.
                entries.push(new TemplateEntry(path, child, (stat.mode & 0o100) !== 0 ? 0o755 : 0o644));
            }
        };
        walk(dir);

        entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        if (entries.length === 0 && skipped.length === 0) {
            return Err(`${TEMPLATE_DIR}/ is empty`);
        }

        return Ok(new Template(dir, entries, skipped.sort()));
    }

    get paths(): readonly string[] {
        return this.entries.map((entry) => entry.path);
    }

    get(path: string): TemplateEntry | undefined {
        return this.index.get(path);
    }

    /** What this template holds at `path`, or null when it holds nothing there. */
    contentAt(path: string): Content | null {
        return this.index.get(path)?.read() ?? null;
    }
}

/**
 * A file's contents, as text unless it looks binary. Everything downstream — the 3-way merge,
 * the conflict-marker scan — is line-oriented, so a PNG has to be recognised before it gets
 * there and copied wholesale instead.
 */
export class Content {
    private constructor(
        private readonly bytes: Buffer,
        /** Null when the bytes are not text, which is what makes "can this be merged" decidable. */
        readonly text: string | null
    ) {}

    static read(absolute: string): Content {
        const bytes = readFileSync(absolute);
        const window = bytes.subarray(0, 8192);
        return new Content(bytes, window.includes(0) ? null : bytes.toString('utf8'));
    }

    /** Null when there is no file there — which is how "the project deleted it" is spelled. */
    static readIfPresent(absolute: string): Content | null {
        return existsSync(absolute) ? Content.read(absolute) : null;
    }

    /** What gets written back: the text, or the original bytes for a binary file. */
    get payload(): string | Buffer {
        return this.text ?? this.bytes;
    }

    equals(other: Content): boolean {
        if (this.text !== null || other.text !== null) return this.text === other.text;
        return this.bytes.equals(other.bytes);
    }
}
