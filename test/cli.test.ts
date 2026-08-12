import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { run } from '../src/cli.js';
import { Env } from '../src/env.js';
import { Git } from '../src/git.js';
import { cleanupScratch, createRepo, scratchDir, templateRepo } from './helpers.js';

afterEach(cleanupScratch);

const VERSION = '0.0.0-test';

async function capture(argv: string[], cwd = process.cwd()): Promise<{ code: number; out: string }> {
    let out = '';
    const sink = (message: string): void => {
        out += `${message}\n`;
    };
    const env = new Env({
        pkg: { name: '@neoskop/scaffold', version: VERSION, description: 'test fixture' },
        cwd,
        vars: { ...process.env },
        log: sink,
        error: sink,
        remote: new Git({ vars: { ...process.env } }),
    });
    return { code: await run(argv, env), out };
}

describe('argument handling', () => {
    it('prints help when called with no arguments', async () => {
        const { code, out } = await capture([]);

        expect(code).toBe(0);
        expect(out).toContain('Usage');
        expect(out).toContain('init');
        expect(out).toContain('update');
    });

    it('prints help for --help and -h', async () => {
        expect((await capture(['--help'])).out).toContain('Usage');
        expect((await capture(['-h'])).out).toContain('Usage');
    });

    it('prints the bare version for --version', async () => {
        expect((await capture(['--version'])).out.trim()).toBe(VERSION);
        expect((await capture(['-v'])).out.trim()).toBe(VERSION);
    });

    it('documents the repo forms where someone will look for them', async () => {
        const { out } = await capture(['--help']);
        expect(out).toContain('org/repo@tag');
        expect(out).toContain('git@host:org/repo');
        expect(out).toMatch(/scaffold\.hooks\.mjs.*runs on your machine/s);
    });

    it('names the required positional in the usage line', async () => {
        const { out } = await capture(['init', '--help']);
        expect(out).toMatch(/init <repo>/);
    });

    it('rejects an unknown command', async () => {
        const { code, out } = await capture(['upgrade']);

        expect(code).toBe(2);
        expect(out).toContain('unknown command "upgrade"');
        expect(out).toContain('--help');
    });

    it('rejects an unknown option', async () => {
        const { code, out } = await capture(['update', '--yolo']);

        expect(code).toBe(2);
        expect(out).toContain('unknown option "--yolo"');
    });

    it('rejects a flag belonging to another command', async () => {
        const { code, out } = await capture(['update', '--adopt']);

        expect(code).toBe(2);
        expect(out).toContain('unknown option "--adopt"');
    });

    it('shows a command its own flags on --help', async () => {
        const { code, out } = await capture(['init', '--help']);

        expect(code).toBe(0);
        expect(out).toContain('--adopt');
        expect(out).toContain('--dir <path>');
        expect(out).not.toContain('--check');
    });

    it('documents the merge-base override on update', async () => {
        const { code, out } = await capture(['update', '--help']);

        expect(code).toBe(0);
        expect(out).toContain('--base <dir>');
        expect(out).not.toContain('--adopt');
    });

    it('rejects a target directory that does not exist', async () => {
        const missing = join(scratchDir('gone'), 'nope');
        const { code, out } = await capture(['update', '--dir', missing]);

        expect(code).toBe(2);
        expect(out).toContain('does not exist');
    });

    it('targets --dir instead of the current directory', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        const repo = createRepo();
        const elsewhere = scratchDir('elsewhere');

        const { code } = await capture(['init', fixture.spec, '--dir', repo.root], elsewhere);

        expect(code).toBe(0);
        expect(repo.exists('a.txt')).toBe(true);
    });
});
