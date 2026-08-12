import { afterEach, describe, expect, it } from 'vitest';

import { baselineTemplate, cleanupScratch, createRepo, snapshot, templateRepo } from './helpers.js';

afterEach(cleanupScratch);

/** A hooks module that records which hooks ran, in order, into a file in the target. */
const RECORDER = [
    "import { appendFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const note = (ctx, name) => appendFileSync(join(ctx.cwd, "hooks.log"), `${name}:${ctx.check}\\n`);',
    'export const preInit = (ctx) => note(ctx, "preInit");',
    'export const postInit = (ctx) => note(ctx, "postInit");',
    'export const preUpdate = (ctx) => note(ctx, "preUpdate");',
    'export const postUpdate = (ctx) => note(ctx, "postUpdate");',
    'export const preSync = (ctx) => note(ctx, "preSync");',
    'export const postSync = (ctx) => note(ctx, "postSync");',
    '',
].join('\n');

describe('loading', () => {
    it('is silent about hooks for a template that ships none', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        const repo = createRepo();

        expect(await repo.run('init', fixture.spec)).toBe(0);
        expect(repo.output()).not.toMatch(/scaffold\.hooks\.mjs/);
    });

    it('announces the file and the commit before running remote code', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks('export function preInit() {}\n');
        const repo = createRepo();

        expect(await repo.run('init', fixture.spec)).toBe(0);
        expect(repo.output()).toMatch(/hooks\s+scaffold\.hooks\.mjs from .*#[0-9a-f]{8}/);
    });

    it('--no-hooks skips them and says it did', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks('export function preInit() { throw new Error("must not run"); }\n');
        const repo = createRepo();

        expect(await repo.run('init', fixture.spec, '--no-hooks')).toBe(0);
        expect(repo.output()).toMatch(/scaffold\.hooks\.mjs skipped/);
    });

    it('reports a syntax error rather than a stack trace', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks('export function preInit( {\n');
        const repo = createRepo();

        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/could not be loaded/);
    });

    it('explains that only node: builtins are available', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks("import _ from 'lodash';\nexport function preInit() {}\n");
        const repo = createRepo();

        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/only node: builtins/);
    });

    it('rejects an export that is not a function', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks('export const preInit = 42;\n');
        const repo = createRepo();

        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/but it is a number rather than a function/);
    });
});

describe('when they run', () => {
    it('brackets the file sync in the documented order', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks(RECORDER);
        const repo = createRepo();

        expect(await repo.run('init', fixture.spec)).toBe(0);
        expect(repo.read('hooks.log').trim().split('\n')).toEqual([
            'preInit:false',
            'preSync:false',
            'postSync:false',
            'postInit:false',
        ]);
    });

    it('runs the same sync pair for update, so common work is written once', async () => {
        const fixture = templateRepo({ 'a.txt': 'v1\n' });
        fixture.hooks(RECORDER);
        const repo = createRepo();
        await repo.run('init', fixture.spec);
        repo.write('hooks.log', '');

        fixture.commit({ 'template/a.txt': 'v2\n' });
        expect(await repo.run('update')).toBe(0);
        expect(repo.read('hooks.log').trim().split('\n')).toEqual([
            'preUpdate:false',
            'preSync:false',
            'postSync:false',
            'postUpdate:false',
        ]);
    });

    it('writes nothing before preSync, so it can still abort the run', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks('export function preSync() { throw new Error("not on this host"); }\n');
        const repo = createRepo();
        const before = snapshot(repo.root);

        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/hook "preSync" of scaffold "template-repo" failed: not on this host/);
        expect(snapshot(repo.root)).toEqual(before);
    });

    it('tells a hook it is a dry run, so --check can still see what it owns', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks(RECORDER);
        const repo = createRepo();
        await repo.run('init', fixture.spec);
        repo.write('hooks.log', '');

        await repo.run('update', '--check');
        expect(repo.read('hooks.log')).toMatch(/preUpdate:true/);
    });

    it('counts what a hook reports, so a hook-owned file keeps --check honest', async () => {
        // The reason ctx.log takes a kind: a hook that could only print strings would let CI
        // go green while the files it manages are out of date.
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks(
            [
                "import { existsSync, writeFileSync } from 'node:fs';",
                "import { join } from 'node:path';",
                'function ensure(ctx) {',
                "    const path = join(ctx.cwd, '.gitignore');",
                '    if (existsSync(path)) return;',
                "    ctx.log('added', '.gitignore', 'required by the template');",
                "    if (!ctx.check) writeFileSync(path, 'node_modules\\n');",
                '}',
                'export const postInit = ensure;',
                'export const postUpdate = ensure;',
                '',
            ].join('\n')
        );

        const repo = createRepo();
        await repo.run('init', fixture.spec, '--no-hooks');
        expect(repo.exists('.gitignore')).toBe(false);

        // With hooks on, --check must notice the missing file and go red.
        expect(await repo.run('update', '--check')).toBe(1);
        expect(repo.output()).toMatch(/would added\s+\.gitignore/);
        expect(repo.exists('.gitignore')).toBe(false);

        expect(await repo.run('update')).toBe(0);
        expect(repo.read('.gitignore')).toBe('node_modules\n');
        expect(await repo.run('update', '--check')).toBe(0);
    });

    it('awaits an async hook', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks(
            [
                "import { writeFileSync } from 'node:fs';",
                "import { join } from 'node:path';",
                'export async function postInit(ctx) {',
                '    await new Promise((r) => setTimeout(r, 10));',
                "    writeFileSync(join(ctx.cwd, 'late.txt'), 'written\\n');",
                '}',
                '',
            ].join('\n')
        );
        const repo = createRepo();

        expect(await repo.run('init', fixture.spec)).toBe(0);
        expect(repo.read('late.txt')).toBe('written\n');
    });

    it('passes the previous commit to an update hook so it can migrate', async () => {
        const fixture = templateRepo({ 'a.txt': 'v1\n' });
        fixture.hooks(
            [
                "import { writeFileSync } from 'node:fs';",
                "import { join } from 'node:path';",
                'export function preUpdate(ctx) {',
                "    writeFileSync(join(ctx.cwd, 'from.txt'), `${ctx.previousCommit}\\n`);",
                '}',
                '',
            ].join('\n')
        );
        const repo = createRepo();
        await repo.run('init', fixture.spec);
        const installed = repo.state().scaffolds['template-repo']?.commit as string;

        fixture.commit({ 'template/a.txt': 'v2\n' });
        await repo.run('update');
        expect(repo.read('from.txt').trim()).toBe(installed);
    });
});

describe('exclude', () => {
    /** What the dev container scaffold does: .pnpmfile.mjs only where pnpm reads it. */
    const PNPM_ONLY = [
        "import { existsSync, readFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'export function exclude(ctx) {',
        "    const path = join(ctx.cwd, 'package.json');",
        "    const pkg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};",
        "    return String(pkg.packageManager ?? '').startsWith('pnpm') ? [] : ['.pnpmfile.mjs'];",
        '}',
        '',
    ].join('\n');

    /** A target that is not a pnpm project, so PNPM_ONLY leaves .pnpmfile.mjs out of it. */
    const npmRepo = (): ReturnType<typeof createRepo> => createRepo({ packageJson: { name: 'npm-project' } });

    type Installed = { fixture: ReturnType<typeof templateRepo>; repo: ReturnType<typeof npmRepo> };

    async function installed(): Promise<Installed> {
        const fixture = templateRepo(baselineTemplate());
        fixture.hooks(PNPM_ONLY);
        const repo = npmRepo();
        expect(await repo.run('init', fixture.spec)).toBe(0);
        return { fixture, repo };
    }

    it('leaves the excluded file uninstalled, unclaimed, and recorded as excluded', async () => {
        const { repo } = await installed();

        expect(repo.exists('.pnpmfile.mjs')).toBe(false);
        expect(repo.exists('.devcontainer/Dockerfile')).toBe(true);
        expect(repo.output()).toMatch(/excluded\s+\.pnpmfile\.mjs/);
        expect(repo.state().scaffolds['template-repo']?.excluded).toEqual(['.pnpmfile.mjs']);

        // Unclaimed, and it stays that way: the base tree ships it, so the recorded answer is
        // what keeps it from being read back as a file this project once had.
        expect(await repo.run('update', '--check')).toBe(0);
        expect(repo.output()).toMatch(/excluded\s+\.pnpmfile\.mjs/);
        expect(repo.output()).not.toMatch(/restored|would add/);
    });

    it('installs the same file where the template says it belongs', async () => {
        const fixture = templateRepo(baselineTemplate());
        fixture.hooks(PNPM_ONLY);
        const repo = createRepo(); // packageManager: pnpm@…

        expect(await repo.run('init', fixture.spec)).toBe(0);
        expect(repo.exists('.pnpmfile.mjs')).toBe(true);
        expect(repo.state().scaffolds['template-repo']?.excluded).toBeUndefined();
    });

    it('is a steady state, so --check stays green', async () => {
        const { repo } = await installed();
        expect(await repo.run('update', '--check')).toBe(0);
    });

    it('replays the recorded answer under --no-hooks, which is what CI runs', async () => {
        // The whole reason .scaffold.json records it: with hooks off nobody can ask, and an
        // unasked question must not be answered "the file is missing" on every CI run.
        const { repo } = await installed();

        expect(await repo.run('update', '--check', '--no-hooks')).toBe(0);
        expect(repo.exists('.pnpmfile.mjs')).toBe(false);

        // And a real --no-hooks run keeps the record rather than clearing it.
        expect(await repo.run('update', '--no-hooks')).toBe(0);
        expect(repo.state().scaffolds['template-repo']?.excluded).toEqual(['.pnpmfile.mjs']);
    });

    it('removes a file that was installed before the answer changed', async () => {
        const fixture = templateRepo(baselineTemplate());
        fixture.hooks(PNPM_ONLY);
        const repo = createRepo();
        await repo.run('init', fixture.spec);
        expect(repo.exists('.pnpmfile.mjs')).toBe(true);

        repo.write('package.json', '{"name":"migrated-to-npm"}\n');
        expect(await repo.run('update', '--check')).toBe(1);
        expect(repo.exists('.pnpmfile.mjs')).toBe(true);

        expect(await repo.run('update')).toBe(0);
        expect(repo.output()).toMatch(/removed\s+\.pnpmfile\.mjs\s+excluded by scaffold\.hooks\.mjs/);
        expect(repo.exists('.pnpmfile.mjs')).toBe(false);
        expect(repo.state().scaffolds['template-repo']?.excluded).toEqual(['.pnpmfile.mjs']);

        // And the removal sticks: the next base ships the file, but the recorded answer says it
        // was never this project's, so nothing puts it back.
        expect(await repo.run('update', '--check')).toBe(0);
        expect(repo.exists('.pnpmfile.mjs')).toBe(false);
    });

    it('never deletes one the project edited — it only stops claiming it', async () => {
        const fixture = templateRepo(baselineTemplate());
        fixture.hooks(PNPM_ONLY);
        const repo = createRepo();
        await repo.run('init', fixture.spec);
        repo.write('.pnpmfile.mjs', 'export default { mine: true };\n');

        repo.write('package.json', '{"name":"migrated-to-npm"}\n');
        expect(await repo.run('update')).toBe(0);

        expect(repo.output()).toMatch(/kept\s+\.pnpmfile\.mjs\s+excluded by scaffold\.hooks\.mjs, and edited since/);
        expect(repo.read('.pnpmfile.mjs')).toBe('export default { mine: true };\n');
        expect(repo.state().scaffolds['template-repo']?.excluded).toEqual(['.pnpmfile.mjs']);
    });

    it('installs a file the answer stopped excluding', async () => {
        const { repo } = await installed();

        repo.write('package.json', '{"name":"now-pnpm","packageManager":"pnpm@11.19.0"}\n');
        expect(await repo.run('update', '--check')).toBe(1);
        expect(await repo.run('update')).toBe(0);

        expect(repo.exists('.pnpmfile.mjs')).toBe(true);
        expect(repo.state().scaffolds['template-repo']?.excluded).toBeUndefined();

        // Now owned: with nothing excluded any more, the base tree claims it outright.
        repo.remove('.pnpmfile.mjs');
        expect(await repo.run('update')).toBe(0);
        expect(repo.output()).toMatch(/restored\s+\.pnpmfile\.mjs/);
    });

    it('is honoured by --adopt, which claims what it keeps', async () => {
        const fixture = templateRepo(baselineTemplate());
        fixture.hooks(PNPM_ONLY);
        const repo = npmRepo();
        repo.write('.devcontainer/Dockerfile', 'FROM node:24\n');

        expect(await repo.run('init', fixture.spec, '--adopt')).toBe(0);
        expect(repo.exists('.pnpmfile.mjs')).toBe(false);
        expect(repo.state().scaffolds['template-repo']?.excluded).toEqual(['.pnpmfile.mjs']);
    });

    it('installs everything under --no-hooks, because there is nothing recorded yet', async () => {
        const fixture = templateRepo(baselineTemplate());
        fixture.hooks(PNPM_ONLY);
        const repo = npmRepo();

        expect(await repo.run('init', fixture.spec, '--no-hooks')).toBe(0);
        expect(repo.exists('.pnpmfile.mjs')).toBe(true);
    });

    it('rejects a path the template does not ship, rather than ignoring it', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks("export const exclude = () => ['typo.txt'];\n");
        const repo = createRepo();
        const before = snapshot(repo.root);

        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/excludes "typo\.txt", which is not in template\//);
        expect(snapshot(repo.root)).toEqual(before);
    });

    it('rejects a return value that is not a list of paths', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks("export const exclude = () => 'a.txt';\n");
        const repo = createRepo();

        // A string is iterable: excluding it character by character would be silent nonsense.
        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/returned a string rather than a list of paths/);
    });

    it('rejects an export that is not a function', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks('export const exclude = [];\n');
        const repo = createRepo();

        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/exports "exclude", but it is a object rather than a function/);
    });

    it('takes a generator function, which is the natural way to write a conditional list', async () => {
        const fixture = templateRepo(baselineTemplate());
        fixture.hooks(
            [
                "import { existsSync, readFileSync } from 'node:fs';",
                "import { join } from 'node:path';",
                'export function* exclude(ctx) {',
                "    const path = join(ctx.cwd, 'package.json');",
                "    const pkg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};",
                "    if (!String(pkg.packageManager ?? '').startsWith('pnpm')) yield '.pnpmfile.mjs';",
                '}',
                '',
            ].join('\n')
        );
        const repo = npmRepo();

        expect(await repo.run('init', fixture.spec)).toBe(0);
        expect(repo.exists('.pnpmfile.mjs')).toBe(false);
        expect(repo.exists('.devcontainer/Dockerfile')).toBe(true);
        expect(repo.state().scaffolds['template-repo']?.excluded).toEqual(['.pnpmfile.mjs']);
    });

    it('takes an async generator, so a hook may await while deciding', async () => {
        const fixture = templateRepo(baselineTemplate());
        fixture.hooks(
            [
                "import { readFile } from 'node:fs/promises';",
                "import { join } from 'node:path';",
                'export async function* exclude(ctx) {',
                "    const pkg = JSON.parse(await readFile(join(ctx.cwd, 'package.json'), 'utf8'));",
                "    if (!String(pkg.packageManager ?? '').startsWith('pnpm')) yield '.pnpmfile.mjs';",
                '}',
                '',
            ].join('\n')
        );
        const repo = npmRepo();

        expect(await repo.run('init', fixture.spec)).toBe(0);
        expect(repo.exists('.pnpmfile.mjs')).toBe(false);
        expect(repo.state().scaffolds['template-repo']?.excluded).toEqual(['.pnpmfile.mjs']);
    });

    it('reports a generator that throws while producing paths', async () => {
        // A generator body does not run when it is called, so this throw surfaces during the
        // walk rather than at the call — and still has to come back as a message, not a crash.
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks("export function* exclude() { yield 'a.txt'; throw new Error('cannot tell'); }\n");
        const repo = createRepo();
        const before = snapshot(repo.root);

        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/hook "exclude" of scaffold "template-repo" failed: cannot tell/);
        expect(snapshot(repo.root)).toEqual(before);
    });

    it('rejects a bad path from a generator as it does from an array', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks("export function* exclude() { yield 'typo.txt'; }\n");
        const repo = createRepo();

        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/excludes "typo\.txt", which is not in template\//);
    });

    it('takes "nothing to exclude" in either spelling', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks('export function exclude() {}\n');
        const repo = createRepo();

        expect(await repo.run('init', fixture.spec)).toBe(0);
        expect(repo.read('a.txt')).toBe('a\n');
    });

    it('aborts the install when it throws, before anything is written', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks('export function exclude() { throw new Error("cannot tell"); }\n');
        const repo = createRepo();
        const before = snapshot(repo.root);

        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/hook "exclude" of scaffold "template-repo" failed: cannot tell/);
        expect(snapshot(repo.root)).toEqual(before);
    });
});

describe('when they fail', () => {
    it('a failing preInit aborts before anything is written', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks('export function preInit() { throw new Error("needs a package.json"); }\n');
        const repo = createRepo();
        const before = snapshot(repo.root);

        expect(await repo.run('init', fixture.spec)).toBe(2);
        expect(repo.output()).toMatch(/hook "preInit" of scaffold "template-repo" failed: needs a package\.json/);
        expect(snapshot(repo.root)).toEqual(before);
    });

    it('a failing postInit still leaves a recorded, updatable install', async () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks('export function postInit() { throw new Error("epilogue broke"); }\n');
        const repo = createRepo();

        // Exit 1, not 2: the files are in place, only the epilogue failed.
        expect(await repo.run('init', fixture.spec)).toBe(1);
        expect(repo.read('a.txt')).toBe('a\n');
        expect(repo.state().scaffolds['template-repo']).toBeDefined();
    });

    it('a failing preUpdate leaves the scaffold on its old commit', async () => {
        const fixture = templateRepo({ 'a.txt': 'v1\n' });
        const repo = createRepo();
        await repo.run('init', fixture.spec);
        const before = repo.state().scaffolds['template-repo']?.commit;

        fixture.hooks('export function preUpdate() { throw new Error("not on the host"); }\n');
        fixture.commit({ 'template/a.txt': 'v2\n' });

        expect(await repo.run('update')).toBe(2);
        expect(repo.read('a.txt')).toBe('v1\n');
        expect(repo.state().scaffolds['template-repo']?.commit).toBe(before);
    });
});
