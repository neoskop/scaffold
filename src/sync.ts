//
// Deciding, per file, what an install or an update does.
//
// The rule the whole tool exists to keep: nothing a project changed is ever overwritten in
// silence. Either the change merges, or it comes back as conflict markers and a non-zero exit.
//
// What makes that decidable is the merge base: the template at the commit recorded as applied.
// It answers all three questions this needs — "what did the project change" (local against base),
// "may this file be deleted" (a file the template dropped goes only if it still matches the base),
// and "was this file ever ours at all" (it is in the base tree, see `ownedAt`). Without it nothing
// here can be decided safely, which is why `update` refuses to write when it cannot be fetched.

import { chmodSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { write } from './fs.js';
import { HOOKS_FILE } from './hooks.js';
import { CONFLICT_MARKER, mergeFile } from './merge.js';
import type { Reporter } from './report.js';
import { Content, type Template, type TemplateEntry } from './template.js';
import { Ok, type Result } from './utils/Result.js';

/**
 * Where a merge gets its common ancestor. "Nothing recorded" and "could not be obtained" are
 * deliberately different: treating a failed fetch as an empty base would turn a network hiccup
 * into conflict markers across the whole repository.
 */
export type Base =
    /** A template tree to merge against. */
    | { kind: 'tree'; tree: Template }
    /** No base recorded, so every difference is honestly a conflict. `init` only. */
    | { kind: 'empty' }
    /** The base could not be had. Reported, never merged against — `--check` only. */
    | { kind: 'unavailable'; reason: string };

export interface SyncOptions {
    check: boolean;
    force: boolean;
    base: Base;
    /**
     * Paths the template ships that this project is not to get, from its `exclude` hook. Not a
     * filter applied before the walk: a path that was installed under an earlier answer still has
     * to be dealt with, and that is only decidable here.
     */
    excluded: ReadonlySet<string>;
    /**
     * The `exclude` answer recorded beside the base commit — not the one that applies now. The
     * two together are what the base tree has to be read through to get back the paths this
     * scaffold installed; see {@link ownedAt}.
     */
    excludedAtBase: ReadonlySet<string>;
    /** Paths another scaffold claims, mapped to its name. */
    owners: ReadonlyMap<string, string>;
    /** This scaffold's name, for messages. */
    name: string;
    labels: { base: string; incoming: string };
}

export interface SyncResult {
    changes: number;
    /** The paths this scaffold now owns, as the post hooks get to see them in `ctx.files`. */
    files: string[];
    removed: string[];
}

/**
 * The paths this scaffold installed, read back out of the merge base instead of out of a list in
 * `/.scaffold.json`.
 *
 * The base tree is what the template shipped at the commit recorded as applied, so minus the
 * `exclude` answer recorded with it, it is exactly what the last run wrote — and unlike a stored
 * list it cannot drift from the tree it describes, or be edited into pointing somewhere else.
 *
 * No base means no claim: `init` starts from nothing, and an update that could not fetch its base
 * has nothing to write anyway.
 */
export function ownedAt(base: Base, excludedAtBase: ReadonlySet<string>): Set<string> {
    if (base.kind !== 'tree') return new Set();
    return new Set(base.tree.paths.filter((path) => !excludedAtBase.has(path)));
}

/**
 * Install or update every file the template owns.
 *
 * An Err means the merge itself could not be performed — git missing or broken — and stops the
 * walk where it happened. Files already written stay written: the state entry is what makes that
 * recoverable, and the caller records it either way.
 */
export function syncTree(
    root: string,
    incoming: Template,
    reporter: Reporter,
    options: SyncOptions
): Result<SyncResult, string> {
    const { check, owners, force, excluded } = options;

    const owned = ownedAt(options.base, options.excludedAtBase);
    const files: string[] = [];
    const removed: string[] = [];
    let changes = 0;

    for (const skipped of incoming.skipped) {
        reporter.record('warn', skipped, 'not a regular file in the template — skipped');
    }

    const paths = [...new Set([...incoming.paths, ...owned])].sort();

    for (const path of paths) {
        const absolute = join(root, path);

        // Left out of this project. A path we never installed is only noted; one we did installs
        // the same question a file dropped upstream does, and gets the same answer.
        if (excluded.has(path)) {
            if (!owned.has(path)) {
                reporter.record('excluded', path, `not for this project, per ${HOOKS_FILE}`);
                continue;
            }
            if (dropped(absolute, path, reporter, options, `excluded by ${HOOKS_FILE}`)) {
                removed.push(path);
                changes += 1;
            }
            continue;
        }

        const claimed = owners.get(path);
        if (claimed !== undefined && !force) {
            reporter.record('conflict', path, `also managed by scaffold "${claimed}" — pass --force to take it over`);
            changes += 1;
            continue;
        }

        const entry = incoming.get(path);

        if (entry === undefined) {
            if (dropped(absolute, path, reporter, options, 'no longer part of the template')) {
                removed.push(path);
                changes += 1;
            }
            // Either way the scaffold stops claiming it: it is gone, or it is the project's now.
            continue;
        }

        const installed = install(entry, absolute, owned.has(path), reporter, options);
        if (installed.isErr()) return installed.castErr();
        if (installed.value) changes += 1;
        files.push(path);
    }

    if (!check) pruneEmpty(root, removed);

    return Ok({ changes, files, removed });
}

/**
 * A file this scaffold installed and is not to install any more — because the template dropped
 * it, or because its `exclude` hook now says it does not belong here. Returns whether it went.
 *
 * The two are the same question, so `reason` is the only thing that differs: the file is on disk
 * because this scaffold put it there, and nothing is going to keep it up to date any more.
 *
 * The merge base decides: still identical to it means nobody touched it, so removing it is
 * just finishing what the template started. Anything else is someone's work, and deleting that
 * behind their back is exactly what this tool promises not to do.
 */
function dropped(
    absolute: string,
    path: string,
    reporter: Reporter,
    { check, force, base, name }: SyncOptions,
    reason: string
): boolean {
    const local = Content.readIfPresent(absolute);
    if (local === null) return false;

    if (force) {
        reporter.record('removed', path, `${reason} — discarded (--force)`);
        if (!check) unlinkSync(absolute);
        return true;
    }

    if (base.kind === 'unavailable') {
        reporter.record('warn', path, `${reason}, but the merge base is unavailable — left in place`);
        return false;
    }

    if (base.kind === 'tree' && (base.tree.contentAt(path)?.equals(local) ?? false)) {
        reporter.record('removed', path, reason);
        if (!check) unlinkSync(absolute);
        return true;
    }

    // Unclaimed rather than deleted: the scaffold no longer owns it, so the next run is quiet,
    // but a change someone made by hand is theirs to delete.
    reporter.record('kept', path, `${reason}, and edited since "${name}" installed it`);
    return false;
}

/** The Ok value is whether anything changed (or would change under --check). */
function install(
    entry: TemplateEntry,
    absolute: string,
    owned: boolean,
    reporter: Reporter,
    options: SyncOptions
): Result<boolean, string> {
    const { check, base, force } = options;
    const { path, mode } = entry;
    const incoming = entry.read();
    const local = Content.readIfPresent(absolute);

    const put = (content: string | Buffer): Result<boolean, string> => {
        if (!check) write(absolute, content, mode);
        return Ok(true);
    };

    // A file the project deleted. A scaffold owns its files, so it comes back — but visibly,
    // because silently re-creating something someone removed on purpose is how a tool loses
    // trust.
    if (local === null) {
        reporter.record(owned ? 'restored' : 'added', path, owned ? 'deleted locally — re-created' : '');
        return put(incoming.payload);
    }

    const localText = local.text;
    const incomingText = incoming.text;

    // Neither side is line-oriented, so there is nothing to merge: it matches, or it does not.
    if (localText === null || incomingText === null) {
        if (local.equals(incoming)) return Ok(fixMode(absolute, mode, path, reporter, check));
        if (force) {
            reporter.record('updated', path, 'overwritten (--force)');
            return put(incoming.payload);
        }
        reporter.record('conflict', path, 'binary file differs — resolve by hand');
        return Ok(true);
    }

    if (localText === incomingText) return Ok(fixMode(absolute, mode, path, reporter, check));

    // --force is the way back to a clean baseline, so it also clears stale markers.
    if (force) {
        reporter.record('updated', path, 'overwritten (--force)');
        return put(incomingText);
    }

    // Merging a file that still has markers in it would produce nonsense.
    if (CONFLICT_MARKER.test(localText)) {
        reporter.record('conflict', path, 'unresolved conflict markers from an earlier update');
        return Ok(true);
    }

    // Merging against nothing would mangle the file, so this only ever reports. The caller
    // guarantees `check` here: `update` refuses outright when it is writing.
    if (base.kind === 'unavailable') {
        reporter.record('updated', path, `differs — merge result unknown, ${base.reason}`);
        return Ok(true);
    }

    // No base recorded (an --adopt install, or a file the template only just gained): an empty
    // base makes every difference a conflict, which is the honest answer. A binary ancestor is
    // no ancestor either, for the same reason.
    const baseText = (base.kind === 'tree' ? base.tree.contentAt(path)?.text : null) ?? '';

    if (localText === baseText) {
        reporter.record('updated', path);
        return put(incomingText);
    }

    return mergeFile({
        local: localText,
        base: baseText,
        incoming: incomingText,
        labels: { local: `${path} (local)`, base: options.labels.base, incoming: options.labels.incoming },
    }).andThen(({ text, conflicts }) => {
        if (text === localText && conflicts === 0) {
            reporter.record('unchanged', path, 'already contains the upstream change');
            return Ok(false);
        }
        if (conflicts > 0) {
            reporter.record('conflict', path, `${conflicts} conflict${conflicts === 1 ? '' : 's'} — resolve by hand`);
        } else {
            reporter.record('merged', path, 'kept your changes');
        }
        return put(text);
    });
}

/** `--adopt`: keep every existing file verbatim, only note how it differs. */
export function adoptTree(
    root: string,
    incoming: Template,
    reporter: Reporter,
    excluded: ReadonlySet<string>
): SyncResult {
    const files: string[] = [];
    let diverged = 0;

    for (const entry of incoming.entries) {
        if (excluded.has(entry.path)) {
            reporter.record('excluded', entry.path, `not for this project, per ${HOOKS_FILE}`);
            continue;
        }
        const absolute = join(root, entry.path);
        const local = Content.readIfPresent(absolute);
        if (local === null) {
            write(absolute, entry.read().payload, entry.mode);
            reporter.record('added', entry.path);
            files.push(entry.path);
            continue;
        }
        const differs = !local.equals(entry.read());
        if (differs) diverged += 1;
        reporter.record('kept', entry.path, differs ? 'differs from the template — kept as the desired state' : '');
        files.push(entry.path);
    }

    return { changes: diverged, files, removed: [] };
}

// ---------------------------------------------------------------------------------------------

/**
 * The executable bit now comes from the checkout rather than a table in this package, so
 * upstream adding or dropping it is a real change — and an invisible one unless it is reported.
 */
function fixMode(absolute: string, mode: number, path: string, reporter: Reporter, check: boolean): boolean {
    const current = statSync(absolute).mode & 0o777;
    const wanted = (current & 0o666) | (mode & 0o111);
    if ((current & 0o111) === (mode & 0o111)) {
        reporter.record('unchanged', path);
        return false;
    }
    reporter.record('updated', path, `mode ${octal(current)} → ${octal(wanted)}`);
    if (!check) chmodSync(absolute, wanted);
    return true;
}

function octal(mode: number): string {
    return `0${(mode & 0o777).toString(8)}`;
}

/** A dropped `template/proxy/` should not leave an empty `.devcontainer/proxy/` behind. */
function pruneEmpty(root: string, removed: readonly string[]): void {
    for (const path of removed) {
        let dir = dirname(join(root, path));
        while (dir.startsWith(root) && dir !== root) {
            try {
                if (readdirSync(dir).length > 0) break;
                rmdirSync(dir);
            } catch {
                break;
            }
            dir = dirname(dir);
        }
    }
}
