import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { parseRefFlag, parseSpec, type RepoSpec, specFromState } from '../src/spec.js';
import { cleanupScratch, scratchDir } from './helpers.js';

afterAll(cleanupScratch);

const cwd = process.cwd();
/** For the specs that must be accepted: unwrap, so an unexpected rejection fails the test. */
const parse = (input: string): RepoSpec => parseSpec(input, { cwd }).unwrap();
/** For the specs that must be rejected: unwrapErr, so an unexpected acceptance fails the test. */
const reason = (input: string): string => parseSpec(input, { cwd }).unwrapErr();

describe('shorthand', () => {
    it('takes org/repo as the default branch of a GitHub repository', () => {
        expect(parse('neoskop/devcontainer-scaffold')).toMatchObject({
            repo: 'neoskop/devcontainer-scaffold',
            url: 'git@github.com:neoskop/devcontainer-scaffold.git',
            name: 'devcontainer-scaffold',
            ref: { kind: 'default', value: '' },
            local: false,
        });
    });

    it('reads everything after the second slash as one branch name', () => {
        expect(parse('neoskop/tpl/feature/nested/name').ref).toEqual({ kind: 'branch', value: 'feature/nested/name' });
    });

    it('reads @ as a tag and # as a commit', () => {
        expect(parse('neoskop/tpl@v1.2.0').ref).toEqual({ kind: 'tag', value: 'v1.2.0' });
        expect(parse('neoskop/tpl#0123456789abcdef').ref).toEqual({ kind: 'commit', value: '0123456789abcdef' });
    });

    it('keeps the repository identity free of the ref', () => {
        for (const input of ['neoskop/tpl/main', 'neoskop/tpl@v1', 'neoskop/tpl#abcdef1']) {
            expect(parse(input).repo).toBe('neoskop/tpl');
        }
    });

    it('refuses a # that is not a hash, and points at the alternatives', () => {
        expect(reason('neoskop/tpl#main')).toMatch(/not a commit hash.*Use @tag or \/branch/s);
    });

    it('refuses a separator with nothing after it', () => {
        expect(reason('neoskop/tpl@')).toMatch(/no ref after it/);
    });
});

describe('URLs', () => {
    it('takes the scp-like SSH form without mistaking its @ for a tag', () => {
        expect(parse('git@github.com:neoskop/tpl.git')).toMatchObject({
            repo: 'git@github.com:neoskop/tpl.git',
            url: 'git@github.com:neoskop/tpl.git',
            name: 'tpl',
            ref: { kind: 'default', value: '' },
        });
    });

    it('pins an SSH URL with #, and does not read it as a commit unless it is one', () => {
        expect(parse('git@github.com:neoskop/tpl.git#main').ref).toEqual({ kind: 'rev', value: 'main' });
        expect(parse('git@github.com:neoskop/tpl.git#v2/rc').ref).toEqual({ kind: 'rev', value: 'v2/rc' });
    });

    it('takes https and strips .git for the name', () => {
        expect(parse('https://git.example.com/team/tpl.git')).toMatchObject({ name: 'tpl', local: false });
    });

    it('refuses unauthenticated transports by scheme', () => {
        expect(reason('http://example.com/a/b')).toMatch(/unauthenticated/);
        expect(reason('git://example.com/a/b')).toMatch(/unauthenticated/);
    });

    it('refuses credentials in the URL', () => {
        expect(reason('https://user:pw@example.com/a/b')).toMatch(/embeds credentials/);
    });
});

describe('local paths', () => {
    it('turns a relative path into a file:// URL', () => {
        const dir = scratchDir('spec');
        const spec = parseSpec('.', { cwd: dir }).unwrap();
        expect(spec.local).toBe(true);
        expect(spec.url.startsWith('file://')).toBe(true);
    });

    it('refuses a path that is not there', () => {
        expect(reason('./definitely-not-here')).toMatch(/does not exist/);
    });

    it('refuses ~ rather than half-expanding it', () => {
        expect(reason('~/templates/x')).toMatch(/only a shell expands/);
    });

    it('suggests ./ when a bare word happens to be a directory', () => {
        const dir = scratchDir('spec');
        mkdirSync(join(dir, 'mytemplate'), { recursive: true });
        expect(parseSpec('mytemplate', { cwd: dir }).unwrapErr()).toMatch(/did you mean \.\/mytemplate/);
    });

    it('still reads org/repo as GitHub even when a directory of that name exists', () => {
        // Deterministic by prefix, never by probing: what a spec means must not depend on the
        // contents of the directory it is typed in.
        const dir = scratchDir('spec');
        mkdirSync(join(dir, 'neoskop/tpl'), { recursive: true });
        expect(parseSpec('neoskop/tpl', { cwd: dir }).unwrap()).toMatchObject({ local: false, repo: 'neoskop/tpl' });
    });
});

describe('hostile input', () => {
    // Every one of these would otherwise reach an argv, a shell, or the filesystem.
    const hostiles: Array<[string, RegExp]> = [
        ['ext::sh -c id', /transport helper/],
        ['git@h:o/r.git ext::sh -c id', /transport helper/],
        ['neoskop/tpl@--upload-pack=touch /tmp/pwned', /not a usable git ref/],
        ['neoskop/tpl/-b', /not a usable git ref/],
        ['neoskop/tpl@..', /not a usable git ref/],
        ['neoskop/tpl@a//b', /not a usable git ref/],
        ['neoskop/tpl@a b', /not a usable git ref/],
        ['neoskop/tpl@a\nb', /not a usable git ref/],
        ['neoskop/tpl@$(id)', /not a usable git ref/],
        ['neoskop/tpl@`id`', /not a usable git ref/],
        ['neoskop/tpl@a:b', /not a usable git ref/],
        ['../../etc/passwd', /does not exist/],
        ['-c', /not a repository spec/],
        ['--exec=foo', /not a repository spec/],
        ['', /a repository is required/],
    ];

    it.each(hostiles)('refuses %s', (input, expected) => {
        expect(reason(input)).toMatch(expected);
    });

    it('never lets a ref start with a dash', () => {
        expect(parseRefFlag('--upload-pack=id').unwrapErr()).toMatch(/may not start with "-"/);
    });
});

describe('specFromState', () => {
    it('round-trips every identity form without re-parsing user syntax', () => {
        const ref = { kind: 'tag', value: 'v1' } as const;
        expect(specFromState('neoskop/tpl', ref, cwd).url).toBe('git@github.com:neoskop/tpl.git');
        expect(specFromState('git@h:o/r.git', ref, cwd).url).toBe('git@h:o/r.git');
        expect(specFromState('/abs/path', ref, cwd).local).toBe(true);
    });
});
