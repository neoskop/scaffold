import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** File contents, or null when the file is not there. */
export function read(path: string): string | null {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function write(path: string, content: string | Buffer, mode?: number): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (mode !== undefined) chmodSync(path, mode);
}

export function readJson(path: string): unknown {
    const raw = read(path);
    return raw === null ? null : JSON.parse(raw);
}

/** Narrow an unknown to a plain object, so `{}`-shaped JSON can be read safely. */
export function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}
