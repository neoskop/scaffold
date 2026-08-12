import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PACKAGE_ROOT, readPackageMeta } from '../src/env.js';
import { cleanupScratch, createRepo, templateRepo } from './helpers.js';

afterEach(cleanupScratch);

// bin/bin.mjs is what `pnpm dlx` executes; it imports the dist/ that vitest's globalSetup
// builds. Both halves of the published layout, exercised together.
const BIN = join(PACKAGE_ROOT, 'bin', 'bin.mjs');
const VERSION = readPackageMeta(PACKAGE_ROOT).version;

function exec(args: string[], vars: Record<string, string> = {}): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, [BIN, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            ...vars,
        },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('the published binary', () => {
    it('is executable, starts with a shebang, and resolves into the compiled dist/', () => {
        expect(existsSync(BIN)).toBe(true);
        expect(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
        expect(statSync(BIN).mode & 0o111).not.toBe(0);
        expect(existsSync(join(PACKAGE_ROOT, 'dist', 'cli.js'))).toBe(true);
    });

    it('reports the package version', () => {
        const { status, output } = exec(['--version']);

        expect(status).toBe(0);
        expect(output.trim()).toBe(VERSION);
    });

    it('installs and then verifies a scaffold end to end', () => {
        // The compiled binary cannot be handed an injected remote, so this is the one test that
        // proves the published layout works against a real repository.
        const fixture = templateRepo({ '.devcontainer/devcontainer.json': '{\n    "name": "sandbox"\n}\n' });
        const repo = createRepo();

        const installed = exec(['init', fixture.spec, '--dir', repo.root]);
        expect(installed.status).toBe(0);
        expect(repo.exists('.devcontainer/devcontainer.json')).toBe(true);
        expect(repo.exists('.scaffold.json')).toBe(true);

        expect(exec(['update', '--check', '--dir', repo.root]).status).toBe(0);
    });

    it('refuses a spec that would put an option into git’s argv', () => {
        const repo = createRepo();
        const { status, output } = exec(['init', 'neoskop/tpl@--upload-pack=id', '--dir', repo.root]);

        expect(status).toBe(2);
        expect(output).toMatch(/not a usable git ref/);
    });

    it('stays off the network when fetching is switched off', () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        const repo = createRepo();
        const { status, output } = exec(['init', fixture.spec, '--dir', repo.root], {
            NEOSKOP_SCAFFOLD_NO_FETCH: '1',
        });

        expect(status).toBe(2);
        expect(output).toMatch(/NEOSKOP_SCAFFOLD_NO_FETCH=1/);
        expect(repo.exists('.scaffold.json')).toBe(false);
    });
});
