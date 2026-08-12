import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const REPO_ROOT = import.meta.dirname;
const INSIDE_CONTAINER = existsSync('/.dockerenv') || !!process.env.DEVCONTAINER || !!process.env.REMOTE_CONTAINERS;
const EXEMPT = INSIDE_CONTAINER || !!process.env.CI || !!process.env.MEND_HOSTED;

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

export const hooks = {
    preResolution() {
        if (EXEMPT) return;

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
    },
};

const ORANGE_BOLD = '\x1b[1;38;5;208m';
const RESET = '\x1b[0m';
