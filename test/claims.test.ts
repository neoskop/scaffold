//
// Two scaffolds in one project, and the file they both want.
//
// Nothing in /.scaffold.json says which paths belong to whom: each scaffold's claim is the
// template at its own recorded commit, minus its recorded `excluded`. These tests are what says
// that reconstruction actually happens across scaffolds — and what happens when it cannot.

import { afterEach, describe, expect, it } from 'vitest';

import { Git, type Remote } from '../src/git.js';
import { Err } from '../src/utils/Result.js';
import { cleanupScratch, createRepo, templateRepo } from './helpers.js';

afterEach(cleanupScratch);

describe('what another scaffold owns', () => {
    it('is read out of its recorded commit, not out of a list in the state file', async () => {
        const one = templateRepo({ 'shared.txt': 'from one\n', 'only-one.txt': '1\n' }, 'one');
        const two = templateRepo({ 'shared.txt': 'from two\n' }, 'two');
        const repo = createRepo();
        expect(await repo.run('init', one.spec, '--name', 'alpha')).toBe(0);

        expect(await repo.run('init', two.spec, '--name', 'beta')).toBe(2);
        expect(repo.output()).toMatch(/already managed by another scaffold/);
        expect(repo.output()).toMatch(/shared\.txt\s+\(alpha\)/);
        // The refusal came from alpha's template tree: there is nothing else it could have come from.
        expect(repo.read('.scaffold.json')).not.toContain('"files"');
        expect(repo.read('shared.txt')).toBe('from one\n');
    });

    it('is reported as a conflict when an update walks into it', async () => {
        const one = templateRepo({ 'shared.txt': 'from one\n' }, 'one');
        const two = templateRepo({ 'shared.txt': 'from two\n' }, 'two');
        const repo = createRepo();
        await repo.run('init', one.spec, '--name', 'alpha');
        expect(await repo.run('init', two.spec, '--name', 'beta', '--force')).toBe(0);

        expect(await repo.run('update', 'alpha')).toBe(1);
        expect(repo.output()).toMatch(/conflict\s+shared\.txt\s+also managed by scaffold "beta"/);
        // Reported, not fought over: beta's version stays.
        expect(repo.read('shared.txt')).toBe('from two\n');
    });

    it('leaves paths its exclude hook dropped out of the claim', async () => {
        // What a project never gets cannot be contested, so the second scaffold may have it.
        const one = templateRepo({ 'shared.txt': 'from one\n' }, 'one');
        one.hooks('export function exclude() {\n    return ["shared.txt"];\n}\n');
        const two = templateRepo({ 'shared.txt': 'from two\n' }, 'two');

        const repo = createRepo();
        expect(await repo.run('init', one.spec, '--name', 'alpha')).toBe(0);
        expect(repo.exists('shared.txt')).toBe(false);

        expect(await repo.run('init', two.spec, '--name', 'beta')).toBe(0);
        expect(repo.read('shared.txt')).toBe('from two\n');
    });

    it('degrades to a warning when its template cannot be fetched', async () => {
        // An unreachable remote belonging to some *other* scaffold must not block this update,
        // and must not be silently read as "it owns nothing" either.
        const one = templateRepo({ 'a.txt': 'a\n' }, 'one');
        const two = templateRepo({ 'b.txt': 'b\n' }, 'two');

        let unreachable = false;
        const real = new Git({ vars: process.env });
        const remote: Remote = {
            resolve: (spec) => real.resolve(spec),
            checkout: (spec, commit) =>
                unreachable && commit === two.head()
                    ? Err('the remote is unreachable')
                    : real.checkout(spec, commit),
        };

        const repo = createRepo({ remote });
        await repo.run('init', one.spec, '--name', 'alpha');
        await repo.run('init', two.spec, '--name', 'beta');

        unreachable = true;
        expect(await repo.run('update', 'alpha')).toBe(0);
        expect(repo.output()).toMatch(/cannot read what scaffold "beta" owns/);
        expect(repo.output()).toMatch(/files shared with it were not checked/);
        expect(repo.read('a.txt')).toBe('a\n');
    });
});
