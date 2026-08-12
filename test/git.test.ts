import { chmodSync, existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { Git, gitError, type GitOptions, isUnadvertised } from '../src/git.js';
import { parseSpec, type RepoSpec } from '../src/spec.js';
import { Template } from '../src/template.js';
import { cleanupScratch, scratchDir, templateRepo } from './helpers.js';

afterAll(cleanupScratch);

function remote(overrides: Partial<GitOptions> = {}): Git {
    return new Git({ vars: { ...process.env }, ...overrides });
}

const spec = (input: string): RepoSpec => parseSpec(input, { cwd: process.cwd() }).unwrap();

describe('Git.resolve', () => {
    it('resolves the default branch', () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        expect(remote().resolve(spec(fixture.spec)).unwrap()).toBe(fixture.head());
    });

    it('resolves a tag to the commit it points at', () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        const tagged = fixture.head();
        fixture.tag('v1.0.0');
        fixture.commit({ 'a.txt': 'moved on\n' });

        expect(remote().resolve(spec(`${fixture.spec}#v1.0.0`)).unwrap()).toBe(tagged);
    });

    it('resolves a branch', () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        const forked = fixture.head();
        fixture.branch('stable');
        fixture.commit({ 'a.txt': 'main moved\n' });

        expect(remote().resolve(spec(`${fixture.spec}#stable`)).unwrap()).toBe(forked);
    });

    it('needs no round trip for a full hash', () => {
        const never = remote({ vars: { NEOSKOP_SCAFFOLD_NO_FETCH: '1' } });
        const sha = 'a'.repeat(40);
        expect(never.resolve(spec(`neoskop/tpl#${sha}`)).unwrap()).toBe(sha);
    });

    it('reports a ref that does not exist rather than throwing', () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        expect(remote().resolve(spec(`${fixture.spec}#nope`)).unwrapErr()).toMatch(/no ref named "nope"/);
    });
});

describe('Git.checkout', () => {
    it('checks out the template and the hooks file next to it', () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        fixture.hooks('export function preInit() {}\n');

        const checkout = remote().checkout(spec(fixture.spec), fixture.head()).unwrap();

        expect(existsSync(join(checkout.dir, 'scaffold.hooks.mjs'))).toBe(true);
        expect(readFileSync(join(checkout.dir, 'template/a.txt'), 'utf8')).toBe('a\n');
        // A tree, not a repository: nothing downstream needs the history.
        expect(existsSync(join(checkout.dir, '.git'))).toBe(false);
    });

    it('preserves the executable bit, which is where file modes now come from', () => {
        const fixture = templateRepo({ 'run.sh': '#!/bin/sh\n' });
        chmodSync(join(fixture.root, 'template/run.sh'), 0o755);
        fixture.commit({});

        const checkout = remote().checkout(spec(fixture.spec), fixture.head()).unwrap();
        const tree = Template.walk(checkout.dir).unwrap();
        expect(tree.get('run.sh')?.mode).toBe(0o755);
    });

    it('refuses to serve a different commit than the one asked for', () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        expect(remote().checkout(spec(fixture.spec), 'b'.repeat(40)).isErr()).toBe(true);
    });

    it('fetches a commit that is buried in the history, not just a tip', () => {
        // The merge base is, by definition, an old commit. Which rung of the ladder gets it
        // depends on the server: a local file:// upload-pack serves any reachable SHA, so this
        // takes the fast path here — what matters is that the right tree comes out either way.
        const fixture = templateRepo({ 'a.txt': 'v1\n' });
        const buried = fixture.head();
        for (let n = 2; n <= 6; n += 1) fixture.commit({ 'a.txt': `v${n}\n` });

        const checkout = remote().checkout(spec(fixture.spec), buried).unwrap();
        expect(checkout.commit).toBe(buried);
        expect(readFileSync(join(checkout.dir, 'template/a.txt'), 'utf8')).toBe('v1\n');
    });

    it('recognises the refusals that make the deepening fallback necessary', () => {
        // Servers with uploadpack.allowReachableSHA1InWant off — GitLab on-prem, Gitea, Azure
        // DevOps — phrase it in several ways, and a local fixture cannot reproduce any of them.
        expect(isUnadvertised('error: Server does not allow request for unadvertised object abc')).toBe(true);
        expect(isUnadvertised('fatal: remote error: upload-pack: not our ref abc')).toBe(true);
        expect(isUnadvertised('fatal: repository not found')).toBe(false);
    });

    it('does not run git hooks from the developer config', () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        const hooks = scratchDir('githooks');
        const marker = join(scratchDir('marker'), 'pwned');
        writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });

        const config = join(scratchDir('gitconfig'), 'config');
        writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n`);

        const result = remote({ vars: { ...process.env, GIT_CONFIG_GLOBAL: config } }).checkout(
            spec(fixture.spec),
            fixture.head()
        );
        expect(result.isOk()).toBe(true);
        expect(existsSync(marker)).toBe(false);
    });

    it('still honours the user’s global git config', () => {
        // The counterpart to running in a scratch directory: repo-local config of the project
        // being scaffolded gets no vote, but $HOME config must keep working — that is where
        // credential helpers, proxies and org-wide url rewrites live, and a private template
        // repo is unreachable without them.
        //
        // A rewrite is the observable stand-in: if this stops applying, so have credentials.
        const real = templateRepo({ 'a.txt': 'via the rewrite\n' }, 'real');
        const alias = 'https://git.invalid/org/tpl';

        const config = join(scratchDir('gitconfig'), 'config');
        writeFileSync(config, `[url "${real.spec}"]\n\tinsteadOf = ${alias}\n`);

        const aliased = { ...spec(real.spec), url: alias };
        const checkout = remote({ vars: { ...process.env, GIT_CONFIG_GLOBAL: config } })
            .checkout(aliased, real.head())
            .unwrap();

        expect(readFileSync(join(checkout.dir, 'template/a.txt'), 'utf8')).toBe('via the rewrite\n');
    });

    it('does not materialise symlinks out of the template', () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        symlinkSync('/etc/passwd', join(fixture.root, 'template/leak'));
        fixture.commit({});

        const checkout = remote().checkout(spec(fixture.spec), fixture.head()).unwrap();
        // core.symlinks=false checks it out as a plain file holding the target path, and the
        // walk then treats it as an ordinary (harmless) file rather than following it.
        expect(readFileSync(join(checkout.dir, 'template/leak'), 'utf8')).toBe('/etc/passwd');
    });
});

describe('temp checkouts', () => {
    it('keeps nothing between runs, and leaves nothing behind once disposed', () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        const commit = fixture.head();

        const first = remote().checkout(spec(fixture.spec), commit).unwrap();

        // A second call is a second clone in its own directory, not a hit on the first.
        const second = remote().checkout(spec(fixture.spec), commit).unwrap();
        expect(second.dir).not.toBe(first.dir);

        first.dispose();
        expect(existsSync(first.dir)).toBe(false);
        // Disposing one must not disturb the other.
        expect(existsSync(second.dir)).toBe(true);

        second.dispose();
        expect(existsSync(second.dir)).toBe(false);
    });

    it('cleans up after itself when the fetch fails', () => {
        // tmpdir() is this test file's own root (see test/setup.ts), so every entry in it is either
        // this suite's or the code under test's, and naming them beats counting them: the diff on a
        // failure is the directory that leaked. Counting `neoskop-scaffold-*` across the real tmpdir
        // is what this used to do, and the number moved whenever a test file running in parallel
        // created or reclaimed a fixture of its own.
        expect(tmpdir()).toContain('neoskop-scaffold-test-');
        const temps = (): string[] => readdirSync(tmpdir()).sort();

        // Listed after the fixture exists, since it has a scratch directory of its own in here.
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        const before = temps();

        expect(remote().checkout(spec(fixture.spec), 'b'.repeat(40)).isErr()).toBe(true);

        // A failed fetch has no dispose() to call, so it has to have cleaned up on its own.
        expect(temps()).toEqual(before);
    });

    it('has nothing to fall back on when fetching is switched off', () => {
        const fixture = templateRepo({ 'a.txt': 'a\n' });
        const offline = { ...process.env, NEOSKOP_SCAFFOLD_NO_FETCH: '1' };

        // Warming it first changes nothing: there is no store to warm.
        expect(remote().checkout(spec(fixture.spec), fixture.head()).isOk()).toBe(true);

        const result = remote({ vars: offline }).checkout(spec(fixture.spec), fixture.head());
        expect(result.unwrapErr()).toMatch(/NEOSKOP_SCAFFOLD_NO_FETCH=1/);
    });
});

describe('gitError', () => {
    it('turns a missing credential into a sentence about credentials', () => {
        const stderr = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
        expect(gitError(stderr)).toMatch(/no credentials/);
    });

    it('recognises a missing ref', () => {
        expect(gitError("fatal: Remote branch nope not found in upstream origin")).toMatch(/no such ref/);
    });

    it('falls back to git’s own first useful line', () => {
        expect(gitError('Cloning into x...\nfatal: repository not found')).toBe('repository not found');
    });
});
