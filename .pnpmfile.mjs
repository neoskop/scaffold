import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// This file deliberately exports no `hooks`. pnpm writes a `pnpmfileChecksum` into the lockfile as
// soon as one is exported, and Renovate resolves with `--ignore-pnpmfile` whenever the bot admin
// disallows scripts — which the hosted app always does — so every Renovate PR would strip the
// checksum back out and the resulting lockfile would fail `pnpm install --frozen-lockfile` in CI
// (pnpm/pnpm#10944). A pnpmfile without hooks is still loaded and executed before resolution, and
// throwing or exiting from module scope still stops pnpm dead; it just isn't checksummed.
//
// The trade-off is that pnpm loads this file for *every* command, `pnpm -v` included, so the guard
// has to select the commands it applies to instead of relying on a resolution hook.

const REPO_ROOT = import.meta.dirname;
const INSIDE_CONTAINER = existsSync('/.dockerenv') || !!process.env.DEVCONTAINER || !!process.env.REMOTE_CONTAINERS;
const EXEMPT = INSIDE_CONTAINER || !!process.env.CI || !!process.env.MEND_HOSTED;

// Every command that resolves dependencies or writes the lockfile. Matched against the whole argv
// rather than just the first word, so global flags (`pnpm --filter x add y`) can't slip past: this
// guard is meant to fail closed, and a false positive only means the command runs in the container
// it should have run in anyway.
const INSTALL_COMMANDS = new Set([
    'install',
    'i',
    'add',
    'update',
    'up',
    'upgrade',
    'remove',
    'rm',
    'uninstall',
    'un',
    'prune',
    'dedupe',
    'import',
    'link',
    'unlink',
    'patch',
    'patch-commit',
    'patch-remove',
]);

const ORANGE_BOLD = '\x1b[1;38;5;208m';
const RESET = '\x1b[0m';

function findDevContainer() {
    const filters = [
        '--filter',
        `label=devcontainer.config_file=${REPO_ROOT}/.devcontainer/devcontainer.json`,
        '--filter',
        `label=devcontainer.local_folder=${REPO_ROOT}`,
    ];

    const result = spawnSync('docker', ['ps', '--quiet', ...filters], { encoding: 'utf8' });

    if (result.error) return { problem: `\`docker\` is not available (${result.error.message})` };
    if (result.status !== 0) return { problem: (result.stderr || '').trim() || 'the docker daemon is not reachable' };

    const id = (result.stdout || '').trim().split('\n')[0];
    if (id) return { id };

    return { problem: 'no running dev container was found for this workspace' };
}

function refuse(problem) {
    throw new Error(
        [
            `Dependency installs must run inside the dev container, but ${problem}.`,
            '',
            '  Open the dev container in:',
            '    - VS Code https://code.visualstudio.com/docs/devcontainers/tutorial',
            '    - WebStorm  https://www.jetbrains.com/help/webstorm/start-dev-container-inside-ide.html',
            '  and retry.',
            '',
        ].join('\n')
    );
}

function redirectToDevContainer() {
    const { id, problem } = findDevContainer();
    if (!id) refuse(problem);

    const pnpmArgs = process.argv.slice(2);
    const execFlags = ['exec', '--interactive', '--user', 'node', '--workdir', process.cwd()];
    if (process.stdin.isTTY && process.stdout.isTTY) execFlags.push('--tty');

    console.error('');
    console.error(`${ORANGE_BOLD}↪ pnpm ${pnpmArgs.join(' ')} → dev container ${id}${RESET}`);
    process.env.VERBOSE && console.error({ execFlags, pnpmArgs });
    console.error('');

    const result = spawnSync('docker', [...execFlags, id, 'pnpm', ...pnpmArgs], { stdio: 'inherit' });
    if (result.error) refuse(`\`docker exec\` failed (${result.error.message})`);

    process.exit(result.status ?? 1);
}

if (!EXEMPT && process.argv.slice(2).some((arg) => INSTALL_COMMANDS.has(arg))) {
    redirectToDevContainer();
}
