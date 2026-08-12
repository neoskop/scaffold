import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ScaffoldState, STATE_FILE } from '../src/state.js';
import { Content, Template } from '../src/template.js';
import { cleanupScratch, createRepo, scratchDir, templateRepo } from './helpers.js';

afterEach(cleanupScratch);

describe('reading', () => {
    it('treats a missing file as no scaffolds', () => {
        expect(ScaffoldState.read(scratchDir('state')).unwrap().isEmpty).toBe(true);
    });

    it('refuses invalid JSON rather than clobbering it', () => {
        const dir = scratchDir('state');
        writeFileSync(join(dir, STATE_FILE), '{ this is a merge conflict');
        expect(ScaffoldState.read(dir).unwrapErr()).toMatch(/not valid JSON/);
    });

    it('refuses a listed path that would escape the project', () => {
        const dir = scratchDir('state');
        writeFileSync(
            join(dir, STATE_FILE),
            JSON.stringify({ scaffolds: { a: { repo: 'o/r', commit: 'x', excluded: ['../../etc/passwd'] } } })
        );
        expect(ScaffoldState.read(dir).unwrapErr()).toMatch(/unusable path/);
    });

    it('drops the "files" list an older version of the CLI wrote', () => {
        // It was a second copy of the merge base's own file list. Reading it back would only
        // create a way for the two to disagree, so it is ignored and gone after the next write.
        const dir = scratchDir('state');
        writeFileSync(
            join(dir, STATE_FILE),
            JSON.stringify({ scaffolds: { a: { repo: 'o/r', commit: 'c', files: ['a.txt'], excluded: ['b.txt'] } } })
        );
        const state = ScaffoldState.read(dir).unwrap();
        expect(state.get('a')).toEqual({
            repo: 'o/r',
            ref: { kind: 'commit', value: 'c' },
            commit: 'c',
            excluded: ['b.txt'],
        });

        state.write(dir);
        expect(readFileSync(join(dir, STATE_FILE), 'utf8')).not.toContain('"files"');
    });

    it('keeps fields a newer version of the CLI may have written', () => {
        const dir = scratchDir('state');
        writeFileSync(
            join(dir, STATE_FILE),
            JSON.stringify({ futureField: { a: 1 }, scaffolds: { x: { repo: 'o/r', commit: 'c' } } })
        );
        const state = ScaffoldState.read(dir).unwrap();
        expect(state.extra['futureField']).toEqual({ a: 1 });

        state.write(dir);
        const written = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as Record<string, unknown>;
        expect(written['futureField']).toEqual({ a: 1 });
    });
});

describe('writing', () => {
    it('sorts scaffolds and paths, so the diff is stable', () => {
        const dir = scratchDir('state');
        const state = ScaffoldState.empty();
        const ref = { kind: 'default', value: '' } as const;
        state.record('zulu', { repo: 'o/z', ref, commit: 'c', excluded: ['d', 'c'] });
        state.record('alpha', { repo: 'o/a', ref, commit: 'c', excluded: [] });
        state.write(dir);
        const text = readFileSync(join(dir, STATE_FILE), 'utf8');
        expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zulu"'));
        expect(text.indexOf('"c"')).toBeLessThan(text.indexOf('"d"'));
        expect(text.endsWith('\n')).toBe(true);
    });

    it('leaves "excluded" out entirely when a template excludes nothing', () => {
        // Which is most of them. An empty array in every entry would be noise in a committed file.
        const dir = scratchDir('state');
        const state = ScaffoldState.empty();
        const ref = { kind: 'default', value: '' } as const;
        state.record('a', { repo: 'o/a', ref, commit: 'c', excluded: [] });
        state.write(dir);

        const written = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as {
            scaffolds: Record<string, object>;
        };
        expect(Object.keys(written.scaffolds['a'] as object)).toEqual(['repo', 'ref', 'commit']);
    });

    it('round-trips the excluded paths', () => {
        const dir = scratchDir('state');
        const state = ScaffoldState.empty();
        const ref = { kind: 'default', value: '' } as const;
        state.record('a', { repo: 'o/a', ref, commit: 'c', excluded: ['.pnpmfile.mjs'] });
        state.write(dir);

        expect(ScaffoldState.read(dir).unwrap().get('a')?.excluded).toEqual(['.pnpmfile.mjs']);
    });
});

describe('the template walk', () => {
    it('mirrors the tree and sorts the entries', () => {
        const fixture = templateRepo({ 'b/second.txt': '2\n', 'a.txt': '1\n' });
        const tree = Template.walk(fixture.root).unwrap();
        expect(tree.paths).toEqual(['a.txt', 'b/second.txt']);
    });

    it('skips anything that is not a regular file instead of following it', () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        symlinkSync('/etc/passwd', join(fixture.root, 'template/leak'));

        const tree = Template.walk(fixture.root).unwrap();
        expect(tree.get('leak')).toBeUndefined();
        expect(tree.skipped).toEqual(['leak']);
    });

    it('reports a repository with no template/ rather than throwing', () => {
        const dir = scratchDir('empty');
        expect(Template.walk(dir).unwrapErr()).toMatch(/no template\/ directory/);
    });
});

describe('binary content', () => {
    it('is recognised and copied whole rather than merged', async () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        writeFileSync(join(fixture.root, 'template/logo.png'), png);
        fixture.commit({});

        const repo = createRepo();
        expect(await repo.run('init', fixture.spec)).toBe(0);
        expect(readFileSync(join(repo.root, 'logo.png')).equals(png)).toBe(true);
        expect(repo.output()).toMatch(/added\s+logo\.png/);
    });

    it('conflicts instead of producing nonsense when both sides changed', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        writeFileSync(join(fixture.root, 'template/logo.png'), Buffer.from([0x00, 0x01]));
        fixture.commit({});

        const repo = createRepo();
        await repo.run('init', fixture.spec);
        writeFileSync(join(repo.root, 'logo.png'), Buffer.from([0x00, 0x09, 0x09]));
        writeFileSync(join(fixture.root, 'template/logo.png'), Buffer.from([0x00, 0x02, 0x03]));
        fixture.commit({});

        expect(await repo.run('update')).toBe(1);
        expect(repo.output()).toMatch(/binary file differs/);
        expect(readFileSync(join(repo.root, 'logo.png')).equals(Buffer.from([0x00, 0x09, 0x09]))).toBe(true);
    });

    it('is detected by a NUL byte, not by extension', () => {
        const dir = scratchDir('content');
        writeFileSync(join(dir, 'text.bin'), 'still just text\n');
        writeFileSync(join(dir, 'real.txt'), Buffer.from([0x61, 0x00, 0x62]));
        expect(Content.read(join(dir, 'text.bin')).text).toBe('still just text\n');
        expect(Content.read(join(dir, 'real.txt')).text).toBeNull();
    });
});
