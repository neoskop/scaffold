import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Checkout, type Remote } from '../src/git.js';
import { Err, Ok } from '../src/utils/Result.js';
import {
    baselineTemplate,
    cleanupScratch,
    createRepo,
    type Fixture,
    resolveKeepingLocal,
    scratchDir,
    snapshot,
    templateRepo,
} from './helpers.js';

afterEach(cleanupScratch);

/** A template repo plus a target that already has it installed. */
async function installed(files = baselineTemplate()): Promise<{ fixture: Fixture; repo: ReturnType<typeof createRepo> }> {
    const fixture = templateRepo(files);
    const repo = createRepo();
    expect(await repo.run('init', fixture.spec)).toBe(0);
    return { fixture, repo };
}

describe('update', () => {
    it('is green and writes nothing when nothing moved', async () => {
        const { repo } = await installed();
        const before = snapshot(repo.root);

        expect(await repo.run('update', '--check')).toBe(0);
        expect(repo.output()).toMatch(/up to date/);
        expect(snapshot(repo.root)).toEqual(before);
    });

    it('pulls a new commit through for a file nobody touched', async () => {
        const { fixture, repo } = await installed();
        fixture.commit({ 'template/.devcontainer/Dockerfile': 'FROM node:24\nRUN echo base\nRUN echo new\n' });

        expect(await repo.run('update')).toBe(0);
        expect(repo.read('.devcontainer/Dockerfile')).toMatch(/echo new/);
        expect(repo.state().scaffolds['template-repo']?.commit).toBe(fixture.head());
    });

    it('merges a local change with an upstream one', async () => {
        const { fixture, repo } = await installed();
        repo.write('.devcontainer/proxy/allowlist.txt', 'registry.npmjs.org\n.github.com\n\n# --- Project\nmine.example\n');
        fixture.commit({
            'template/.devcontainer/proxy/allowlist.txt': 'registry.npmjs.org\n.github.com\nupstream.example\n\n# --- Project\n',
        });

        expect(await repo.run('update')).toBe(0);
        const merged = repo.read('.devcontainer/proxy/allowlist.txt');
        expect(merged).toMatch(/mine\.example/);
        expect(merged).toMatch(/upstream\.example/);
        expect(repo.output()).toMatch(/merged/);
    });

    it('leaves conflict markers and exits 1 on a real collision', async () => {
        const { fixture, repo } = await installed();
        repo.patch('.devcontainer/Dockerfile', 'RUN echo base', 'RUN echo mine');
        fixture.commit({ 'template/.devcontainer/Dockerfile': 'FROM node:24\nRUN echo theirs\n' });

        expect(await repo.run('update')).toBe(1);
        expect(repo.read('.devcontainer/Dockerfile')).toMatch(/^<{7} /m);
        expect(repo.output()).toMatch(/need manual resolution/);

        // ...and --check stays red until a human resolves them.
        expect(await repo.run('update', '--check')).toBe(1);
        repo.write('.devcontainer/Dockerfile', resolveKeepingLocal(repo.read('.devcontainer/Dockerfile')));
        expect(await repo.run('update', '--check')).toBe(0);
    });

    it('--check reports what would change without writing it', async () => {
        const { fixture, repo } = await installed();
        fixture.commit({ 'template/.devcontainer/Dockerfile': 'FROM node:26\n' });
        const before = snapshot(repo.root);

        expect(await repo.run('update', '--check')).toBe(1);
        expect(repo.output()).toMatch(/would updated?/);
        expect(snapshot(repo.root)).toEqual(before);
        expect(await repo.run('update', '--dry-run')).toBe(1);
    });

    it('moves to a tag when told to, and records it', async () => {
        const { fixture, repo } = await installed({ 'a.txt': 'v1\n' });
        fixture.commit({ 'template/a.txt': 'v2\n' });
        fixture.tag('v2.0.0');
        fixture.commit({ 'template/a.txt': 'v3\n' });

        expect(await repo.run('update', '--ref', 'v2.0.0')).toBe(0);
        expect(repo.read('a.txt')).toBe('v2\n');
        expect(repo.state().scaffolds['template-repo']?.ref).toEqual({ kind: 'rev', value: 'v2.0.0' });
    });
});

describe('the recorded file list', () => {
    it('needs no second fetch when nothing moved', async () => {
        const fixture = templateRepo({ 'a.txt': 'v1\n' });
        const { Git } = await import('../src/git.js');
        const fetched: string[] = [];
        const inner = new Git({ vars: { ...process.env } });
        const counting: Remote = {
            resolve: (spec) => inner.resolve(spec),
            checkout: (spec, commit) => {
                fetched.push(commit);
                return inner.checkout(spec, commit);
            },
        };

        const repo = createRepo({ remote: counting });
        expect(await repo.run('init', fixture.spec)).toBe(0);

        fetched.length = 0;
        expect(await repo.run('update', '--check')).toBe(0);
        // The incoming tree IS the base when the commit has not moved, so the steady state
        // costs one resolve and one (cached) checkout, never two.
        expect(fetched).toEqual([fixture.head()]);
    });

    it('is what tells a dropped file from one the scaffold never owned', async () => {
        const { fixture, repo } = await installed({ 'a.txt': 'a\n' });
        repo.write('mine.txt', 'the project’s own file\n');
        fixture.commit({ 'template/a.txt': 'a2\n' });

        expect(await repo.run('update')).toBe(0);
        // Never in the base tree, so never ours to touch.
        expect(repo.read('mine.txt')).toBe('the project’s own file\n');
        expect(repo.output()).not.toMatch(/mine\.txt/);
    });

    it('delete a file dropped upstream that nobody touched', async () => {
        const { fixture, repo } = await installed({ 'a.txt': 'a\n', 'gone.txt': 'bye\n' });
        fixture.commit({ 'template/gone.txt': null });

        expect(await repo.run('update')).toBe(0);
        expect(repo.exists('gone.txt')).toBe(false);
        expect(repo.output()).toMatch(/removed\s+gone\.txt/);
    });

    it('keep a file dropped upstream that was edited locally', async () => {
        const { fixture, repo } = await installed({ 'a.txt': 'a\n', 'gone.txt': 'bye\n' });
        repo.write('gone.txt', 'I still want this\n');
        fixture.commit({ 'template/gone.txt': null });

        expect(await repo.run('update')).toBe(0);
        expect(repo.read('gone.txt')).toBe('I still want this\n');
        expect(repo.output()).toMatch(/edited since "template-repo" installed it/);
        // The new base does not ship it either, so it is unclaimed and the next run is quiet.
        expect(await repo.run('update', '--check')).toBe(0);
        expect(repo.output()).not.toMatch(/gone\.txt/);
    });

    it('leaves a dropped file alone when the merge base cannot be reached at all', async () => {
        // Without the base there is no way to know the scaffold ever owned gone.txt, so --check
        // says "out of sync, and here is why I cannot be precise" rather than naming files it
        // would be guessing about. Nothing is written either way.
        const { fixture, repo } = await installed({ 'a.txt': 'a\n', 'gone.txt': 'bye\n' });
        const moved = fixture.commit({ 'template/gone.txt': null });

        const offline = createRepo({
            remote: {
                resolve: () => Ok(moved),
                checkout: (_spec, commit) =>
                    commit === moved
                        ? Ok(new Checkout(fixture.root, commit, () => {}))
                        : Err('the remote is unreachable'),
            } satisfies Remote,
        });
        offline.write('.scaffold.json', repo.read('.scaffold.json'));
        offline.write('a.txt', 'a\n');
        offline.write('gone.txt', 'bye\n');

        expect(await offline.run('update', '--check')).toBe(1);
        expect(offline.output()).toMatch(/merge base \w+ unavailable — the remote is unreachable/);
        expect(offline.exists('gone.txt')).toBe(true);
    });

    it('still reports a dropped file it cannot judge when the base is a local checkout', async () => {
        // --base hands over a tree, so ownership is known; only the file's own history is not,
        // because this checkout is not the recorded commit.
        const { fixture, repo } = await installed({ 'a.txt': 'a\n', 'gone.txt': 'bye\n' });
        const stale = scratchDir('stale-base');
        mkdirSync(join(stale, 'template'), { recursive: true });
        writeFileSync(join(stale, 'template/a.txt'), 'a\n');
        writeFileSync(join(stale, 'template/gone.txt'), 'something else entirely\n');
        fixture.commit({ 'template/gone.txt': null });

        expect(await repo.run('update', '--check', '--base', stale)).toBe(1);
        expect(repo.output()).toMatch(/gone\.txt/);
        expect(repo.exists('gone.txt')).toBe(true);
    });

    it('refuses to write at all when the merge base cannot be had', async () => {
        const { fixture, repo } = await installed({ 'a.txt': 'v1\n' });
        const moved = fixture.commit({ 'template/a.txt': 'v2\n' });

        const offline = createRepo({
            remote: {
                resolve: () => Ok(moved),
                checkout: (_spec, commit) =>
                    commit === moved
                        ? Ok(new Checkout(fixture.root, commit, () => {}))
                        : Err('the remote is unreachable'),
            } satisfies Remote,
        });
        offline.write('.scaffold.json', repo.read('.scaffold.json'));
        offline.write('a.txt', 'v1\n');
        const before = snapshot(offline.root);

        expect(await offline.run('update')).toBe(2);
        expect(offline.output()).toMatch(/which is the merge base/);
        expect(snapshot(offline.root)).toEqual(before);
    });

    it('prune a directory left empty by a deletion', async () => {
        const { fixture, repo } = await installed({ 'nested/deep/x.txt': 'x\n', 'a.txt': 'a\n' });
        fixture.commit({ 'template/nested/deep/x.txt': null });

        expect(await repo.run('update')).toBe(0);
        expect(repo.exists('nested')).toBe(false);
    });

    it('restore a file the project deleted, and say so', async () => {
        const { repo } = await installed({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
        repo.remove('b.txt');

        expect(await repo.run('update')).toBe(0);
        expect(repo.read('b.txt')).toBe('b\n');
        expect(repo.output()).toMatch(/restored\s+b\.txt/);
        expect(repo.output()).toMatch(/deleted locally/);
    });

    it('--force resets a customized file to the template', async () => {
        const { repo } = await installed({ 'a.txt': 'a\n' });
        repo.write('a.txt', 'hand edited\n');

        expect(await repo.run('update', '--force')).toBe(0);
        expect(repo.read('a.txt')).toBe('a\n');
        expect(repo.output()).toMatch(/overwritten \(--force\)/);
    });

    it('stays quiet when a hook edits a file the template just installed', async () => {
        // Mirroring one list into another is a normal thing for a template to do, and it makes
        // the installed file differ from the template for good. The merge is what settles it:
        // the local edit is not in the base either, so it comes back as "already contains the
        // upstream change" rather than as drift.
        const fixture = templateRepo({ 'conf.json': '{\n    "extensions": []\n}\n' });
        fixture.hooks(
            [
                "import { readFileSync, writeFileSync } from 'node:fs';",
                "import { join } from 'node:path';",
                'export function postInit(ctx) {',
                "    const path = join(ctx.cwd, 'conf.json');",
                '    if (ctx.check) return;',
                "    writeFileSync(path, readFileSync(path, 'utf8').replace('[]', '[\"a.b\"]'));",
                '}',
                'export const postUpdate = postInit;',
                '',
            ].join('\n')
        );

        const repo = createRepo();
        expect(await repo.run('init', fixture.spec)).toBe(0);
        expect(repo.read('conf.json')).toMatch(/a\.b/);
        expect(await repo.run('update', '--check')).toBe(0);
    });
});

describe('several scaffolds', () => {
    it('updates all of them by default and one when named', async () => {
        const one = templateRepo({ 'a.txt': 'a1\n' }, 'one');
        const two = templateRepo({ 'b.txt': 'b1\n' }, 'two');
        const repo = createRepo();
        await repo.run('init', one.spec, '--name', 'alpha');
        await repo.run('init', two.spec, '--name', 'beta');

        one.commit({ 'template/a.txt': 'a2\n' });
        two.commit({ 'template/b.txt': 'b2\n' });

        expect(await repo.run('update', 'alpha')).toBe(0);
        expect(repo.read('a.txt')).toBe('a2\n');
        expect(repo.read('b.txt')).toBe('b1\n');

        expect(await repo.run('update')).toBe(0);
        expect(repo.read('b.txt')).toBe('b2\n');
    });

    it('reports an unknown name and lists the ones there are', async () => {
        const { repo } = await installed({ 'a.txt': 'a\n' });
        expect(await repo.run('update', 'nope')).toBe(2);
        expect(repo.output()).toMatch(/no scaffold named "nope"/);
        expect(repo.output()).toMatch(/Installed: template-repo/);
    });

    it('finishes the others when one fails, and keeps what it already wrote', async () => {
        const one = templateRepo({ 'a.txt': 'a1\n' }, 'one');
        const two = templateRepo({ 'b.txt': 'b1\n' }, 'two');
        const repo = createRepo();
        await repo.run('init', one.spec, '--name', 'alpha');
        await repo.run('init', two.spec, '--name', 'beta');

        one.commit({ 'template/a.txt': 'a2\n' });
        // Make beta's remote unreachable by pointing it somewhere that is not there.
        const state = JSON.parse(repo.read('.scaffold.json')) as { scaffolds: Record<string, { repo: string }> };
        (state.scaffolds['beta'] as { repo: string }).repo = '/nonexistent/template-repo';
        repo.write('.scaffold.json', JSON.stringify(state, null, 4));

        expect(await repo.run('update')).toBe(2);
        expect(repo.read('a.txt')).toBe('a2\n');
        expect(repo.output()).toMatch(/beta/);
    });

    it('refuses --ref when more than one scaffold is in scope', async () => {
        const one = templateRepo({ 'a.txt': 'a\n' }, 'one');
        const two = templateRepo({ 'b.txt': 'b\n' }, 'two');
        const repo = createRepo();
        await repo.run('init', one.spec, '--name', 'alpha');
        await repo.run('init', two.spec, '--name', 'beta');

        expect(await repo.run('update', '--ref', 'v1')).toBe(2);
        expect(repo.output()).toMatch(/apply to one scaffold/);
    });
});

describe('without the merge base', () => {
    const unreachable: Remote = {
        resolve: () => Ok('f'.repeat(40)),
        checkout: () => Err('the remote is unreachable'),
    };

    it('refuses to write, rather than merging against nothing', async () => {
        const { fixture, repo } = await installed({ 'a.txt': 'a\n' });
        repo.write('a.txt', 'customized\n');
        fixture.commit({ 'template/a.txt': 'upstream\n' });

        const broken = createRepo({ remote: unreachable });
        broken.write('.scaffold.json', repo.read('.scaffold.json'));
        broken.write('a.txt', 'customized\n');
        const before = snapshot(broken.root);

        expect(await broken.run('update')).toBe(2);
        expect(broken.output()).toMatch(/cannot fetch/);
        expect(snapshot(broken.root)).toEqual(before);
    });

    it('degrades to a warning under --check instead of claiming to know', async () => {
        const { repo } = await installed({ 'a.txt': 'a\n' });
        const broken = createRepo({
            remote: {
                resolve: () => Err('the remote is unreachable'),
                checkout: () => Err('the remote is unreachable'),
            },
        });
        broken.write('.scaffold.json', repo.read('.scaffold.json'));
        broken.write('a.txt', 'a\n');

        expect(await broken.run('update', '--check')).toBe(2);
        expect(broken.output()).toMatch(/could not reach/);
        // Not "out of sync": we could not tell, and saying otherwise would be a lie in CI.
        expect(broken.output()).not.toMatch(/out of sync/);
    });

    it('takes a local checkout as the base with --base', async () => {
        const { fixture, repo } = await installed({ 'a.txt': 'a\n' });
        repo.write('a.txt', 'customized\n');
        fixture.commit({ 'template/a.txt': 'a\nupstream\n' });

        expect(await repo.run('update', '--base', fixture.root)).toBe(0);
    });

    it('rejects a --base that is not a checkout', async () => {
        const { repo } = await installed({ 'a.txt': 'a\n' });
        expect(await repo.run('update', '--base', repo.root)).toBe(2);
        expect(repo.output()).toMatch(/does not look like a template checkout/);
    });
});
