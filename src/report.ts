import { neon, type NeonObject } from './utils/neon.js';

export type ReportKind =
    | 'added'
    /** A file the project deleted and a scaffold that owns it put back. */
    | 'restored'
    | 'updated'
    | 'merged'
    | 'unchanged'
    | 'kept'
    /** In the template, but the template's own `exclude` hook says not for this project. */
    | 'excluded'
    | 'removed'
    | 'conflict'
    | 'warn';

export interface ReportEntry {
    kind: ReportKind;
    path: string;
    detail: string;
}

/** Kinds that mean "the run would write something", i.e. what --check counts. */
const CHANGE_KINDS = new Set<ReportKind>(['added', 'restored', 'updated', 'merged', 'removed', 'conflict']);

function styleForKind(kind: ReportKind): NeonObject {
    switch (kind) {
        case 'conflict':
            return neon.red;
        case 'warn':
        case 'removed':
            return neon.yellow;
        case 'added':
        case 'restored':
        case 'updated':
        case 'merged':
            return neon.green;
        case 'unchanged':
        case 'kept':
        case 'excluded':
            return neon.dim;
    }
}

export class Reporter {
    readonly entries: ReportEntry[] = [];

    record(kind: ReportKind, path: string, detail = ''): void {
        this.entries.push({ kind, path, detail });
    }

    get conflicts(): ReportEntry[] {
        return this.entries.filter((entry) => entry.kind === 'conflict');
    }

    /** How many entries mean "something would be written". */
    get changes(): number {
        return this.entries.filter((entry) => CHANGE_KINDS.has(entry.kind)).length;
    }

    flush(log: (message: string) => void, check: boolean): void {
        if (this.entries.length === 0) return;
        const width = Math.max(...this.entries.map((entry) => entry.kind.length)) + (check ? 6 : 0);
        for (const { kind, path, detail } of this.entries) {
            const label = (check && CHANGE_KINDS.has(kind) ? `would ${kind}` : kind).padEnd(width + 2);
            const style = styleForKind(kind);
            const suffix = detail ? ` ${neon.dim`${detail}`}` : '';
            log(`  ${style`${label}`}${path}${suffix}`);
        }
    }
}
