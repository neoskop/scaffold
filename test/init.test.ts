import { statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { baselineTemplate, cleanupScratch, createRepo, snapshot, templateRepo } from './helpers.js';

afterEach(cleanupScratch);

describe('init', () => {
    it('installs the template mirrored onto the target tree', async () => {
        const fixture = templateRepo(baselineTemplate());
        const repo = createRepo();

        expect(await repo.run('init', fixture.spec)).toBe(0);

        expect(repo.exists('.devcontainer/Dockerfile')).toBe(true);
        expect(repo.exists('.devcontainer/proxy/allowlist.txt')).toBe(true);
        // The `root/` bucket is gone: a file at the top of template/ lands at the top here.
        expect(repo.exists('.pnpmfile.mjs')).toBe(true);
    });

    it('records the repo and the resolved commit, and nothing else', async () => {
        // No file list: the template at `commit` is that list, and a second copy in a committed
        // file could only ever disagree with it.
        const fixture = templateRepo(baselineTemplate());
        const repo = createRepo();
        await repo.run('init', fixture.spec);

        const entry = repo.state().scaffolds['template-repo'];
        expect(entry).toEqual({
            // Relative even though a file:// URL was typed: .scaffold.json is committed, so an
            // absolute path in it would name one developer's disk. See the round-trip below.
            repo: relative(repo.root, fixture.root),
            commit: fixture.head(),
            ref: { kind: 'default', value: '' },
        });
        expect(isAbsolute(entry?.repo ?? '')).toBe(false);
        expect(resolve(repo.root, entry?.repo ?? '')).toBe(fixture.root);
    });

    it('takes the executable bit from the template', async () => {
        const fixture = templateRepo({ 'setup.sh': '#!/bin/sh\n' });
        const { chmodSync } = await import('node:fs');
        chmodSync(join(fixture.root, 'template/setup.sh'), 0o755);
        fixture.commit({});

        const repo = createRepo();
        await repo.run('init', fixture.spec);
        expect(statSync(join(repo.root, 'setup.sh')).mode & 0o111).not.toBe(0);
    });

    it('pins to a tag when one is given, and records it', async () => {
        const fixture = templateRepo({ 'a.txt': 'v1\n' });
        const tagged = fixture.head();
        fixture.tag('v1.0.0');
        fixture.commit({ 'a.txt': 'v2\n' });

        const repo = createRepo();
        await repo.run('init', `${fixture.spec}#v1.0.0`);

        expect(repo.read('a.txt')).toBe('v1\n');
        expect(repo.state().scaffolds['template-repo']).toMatchObject({
            commit: tagged,
            ref: { kind: 'rev', value: 'v1.0.0' },
        });
    });

    it('refuses a second install of the same name, and says what to do instead', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        const repo = createRepo();
        await repo.run('init', fixture.spec);

        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/already installed/);
        expect(repo.output()).toMatch(/update template-repo/);
    });

    it('requires a repository argument', async () => {
        const repo = createRepo();
        expect(await repo.run('init')).toBe(2);
        expect(repo.output()).toMatch(/which repository/);
    });

    it('refuses a target that is not a git repository', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        const repo = createRepo({ git: false });
        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/not a git repository/);
    });

    it('refuses a repository with no template/ and writes nothing', async () => {
        const fixture = templateRepo();
        fixture.commit({ 'README.md': 'no template here\n' });
        const repo = createRepo();
        const before = snapshot(repo.root);

        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/is not a scaffold/);
        expect(snapshot(repo.root)).toEqual(before);
    });

    it('installs two scaffolds side by side under separate keys', async () => {
        const one = templateRepo({ 'a.txt': 'a\n' }, 'one');
        const two = templateRepo({ 'b.txt': 'b\n' }, 'two');
        const repo = createRepo();

        expect(await repo.run('init', one.spec, '--name', 'alpha')).toBe(0);
        expect(await repo.run('init', two.spec, '--name', 'beta')).toBe(0);

        expect(Object.keys(repo.state().scaffolds).sort()).toEqual(['alpha', 'beta']);
        expect(repo.exists('a.txt')).toBe(true);
        expect(repo.exists('b.txt')).toBe(true);
    });

    it('refuses to let a second scaffold claim a file the first owns', async () => {
        const one = templateRepo({ 'shared.txt': 'from one\n' }, 'one');
        const two = templateRepo({ 'shared.txt': 'from two\n' }, 'two');
        const repo = createRepo();
        await repo.run('init', one.spec, '--name', 'alpha');

        expect(await repo.run('init', two.spec, '--name', 'beta')).toBe(2);
        expect(repo.output()).toMatch(/already managed by another scaffold/);
        expect(repo.read('shared.txt')).toBe('from one\n');
    });

    it('--adopt keeps what is already there and records it as the desired state', async () => {
        const fixture = templateRepo(baselineTemplate());
        const repo = createRepo();
        repo.write('.devcontainer/Dockerfile', 'FROM node:24\nRUN echo mine\n');

        expect(await repo.run('init', fixture.spec, '--adopt')).toBe(0);
        expect(repo.read('.devcontainer/Dockerfile')).toBe('FROM node:24\nRUN echo mine\n');
        expect(repo.output()).toMatch(/kept\s+\.devcontainer\/Dockerfile/);
        expect(repo.output()).toMatch(/differ from the template and were kept as-is/);

        // Adopted files are owned like any other — which is now read out of the recorded commit
        // rather than a list, so a local deletion still comes back.
        repo.remove('.devcontainer/Dockerfile');
        expect(await repo.run('update')).toBe(0);
        expect(repo.output()).toMatch(/restored\s+\.devcontainer\/Dockerfile/);
    });
});
