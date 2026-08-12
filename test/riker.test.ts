import { describe, expect, expectTypeOf, it } from 'vitest';

import { Ok, type Result } from '../src/utils/Result.js';
import { Riker, type Flags } from '../src/utils/riker.js';

interface Sink {
    lines: string[];
    text: () => string;
}

/** A root Riker whose output is captured instead of printed. */
function tool(): { riker: Riker; out: Sink } {
    const lines: string[] = [];
    const out: Sink = { lines, text: () => lines.join('\n') };
    const riker = new Riker({
        name: 'tool',
        version: '1.2.3',
        description: 'a test fixture',
        log: (message) => lines.push(message),
        error: (message) => lines.push(message),
    });
    return { riker, out };
}

/**
 * `run` is only a promise when the handler is one, and every assertion below except the async
 * test is about what happens before a handler is reached.
 */
function sync(result: ReturnType<Riker['run']>): Result<number, string> {
    if (result instanceof Promise) throw new Error('expected a synchronous result, got a promise');
    return result;
}

/** The exit code of a run that is expected to succeed. */
const codeOf = (result: ReturnType<Riker['run']>): number => sync(result).unwrap();
/** The message of a run that is expected to be rejected. */
const errorOf = (result: ReturnType<Riker['run']>): string => sync(result).unwrapErr();

describe('boolean flags', () => {
    it('defaults to false, or to the declared default', () => {
        let seen: unknown;
        const result = tool()
            .riker.flag({ name: 'force' })
            .flag({ name: 'loud', default: true })
            .command((flags) => {
                seen = flags;
                return Ok(0);
            })
            .run([]);

        expect(codeOf(result)).toBe(0);
        expect(seen).toEqual({ force: false, loud: true });
    });

    it('is true when passed, and nothing else leaks into the handler', () => {
        let seen: unknown;
        tool()
            .riker.flag({ name: 'force' })
            .command((flags) => {
                seen = flags;
                return Ok(0);
            })
            .run(['--force']);

        expect(seen).toEqual({ force: true });
    });

    it('accepts --no-<name> only when allowNo is set', () => {
        const build = (allowNo: boolean, argv: string[]): boolean | undefined => {
            let seen: boolean | undefined;
            tool()
                .riker.flag({ name: 'force', default: true, allowNo })
                .command((flags) => {
                    seen = flags.force;
                    return Ok(0);
                })
                .run(argv);
            return seen;
        };

        expect(build(true, ['--no-force'])).toBe(false);
        expect(build(true, [])).toBe(true);
        // Without allowNo it is not a negation but an unknown option, and the handler never runs.
        expect(build(false, ['--no-force'])).toBeUndefined();
        expect(
            errorOf(
                tool()
                    .riker.flag({ name: 'force', default: true })
                    .command(() => Ok(0))
                    .run(['--no-force'])
            )
        ).toMatch(/unknown option "--no-force"/);
    });

    it('refuses an inline value', () => {
        expect(
            errorOf(
                tool()
                    .riker.flag({ name: 'force' })
                    .command(() => Ok(0))
                    .run(['--force=yes'])
            )
        ).toMatch(/option "--force" does not take a value/);
    });
});

describe('string flags', () => {
    it('reads both --flag value and --flag=value', () => {
        const read = (argv: string[]): string | undefined => {
            let seen: string | undefined;
            tool()
                .riker.flag({ name: 'dir', type: 'string' })
                .command((flags) => {
                    seen = flags.dir;
                    return Ok(0);
                })
                .run(argv);
            return seen;
        };

        expect(read(['--dir', '/tmp/x'])).toBe('/tmp/x');
        expect(read(['--dir=/tmp/x'])).toBe('/tmp/x');
        expect(read(['--dir='])).toBe('');
        expect(read([])).toBeUndefined();
    });

    it('falls back to the declared default', () => {
        let seen: string | undefined;
        tool()
            .riker.flag({ name: 'dir', type: 'string', default: '.' })
            .command((flags) => {
                seen = flags.dir;
                return Ok(0);
            })
            .run([]);

        expect(seen).toBe('.');
    });

    it('rejects a missing value', () => {
        expect(
            errorOf(
                tool()
                    .riker.flag({ name: 'dir', type: 'string' })
                    .command(() => Ok(0))
                    .run(['--dir'])
            )
        ).toMatch(/option "--dir" requires a value/);
    });

    it('takes a value that looks like a flag', () => {
        let seen: string | undefined;
        tool()
            .riker.flag({ name: 'dir', type: 'string' })
            .command((flags) => {
                seen = flags.dir;
                return Ok(0);
            })
            .run(['--dir', '--weird']);

        expect(seen).toBe('--weird');
    });
});

describe('shorts, positionals and errors', () => {
    it('matches single-character shorts', () => {
        let seen: unknown;
        tool()
            .riker.flag({ name: 'force', short: 'f' })
            .flag({ name: 'dir', type: 'string', short: 'd' })
            .command((flags) => {
                seen = flags;
                return Ok(0);
            })
            .run(['-f', '-d', '/tmp']);

        expect(seen).toEqual({ force: true, dir: '/tmp' });
    });

    it('collects positionals in order and stops parsing flags after --', () => {
        let seen: string[] | undefined;
        tool()
            .riker.flag({ name: 'force' })
            .command((_flags, positionals) => {
                seen = positionals;
                return Ok(0);
            })
            .run(['one', 'two', '--', '--force', 'three']);

        expect(seen).toEqual(['one', 'two', '--force', 'three']);
    });

    it('reports an unknown option and points at --help', () => {
        expect(
            errorOf(
                tool()
                    .riker.command(() => Ok(0))
                    .run(['--yolo'])
            )
        ).toMatch(/unknown option "--yolo" — try --help/);
    });

    it('hands a parse error back as a value instead of printing or throwing it', () => {
        const seen: string[] = [];
        const plain = new Riker({ name: 'tool', log: (message) => seen.push(message) }).command(() => Ok(0));

        expect(errorOf(plain.run(['--yolo']))).toMatch(/unknown option "--yolo"/);
        // Deciding what a failure looks like belongs to the caller, so Riker prints nothing.
        expect(seen).toEqual([]);
    });

    it('passes the handler exit code through', () => {
        const codeFrom = (code: number): number =>
            codeOf(
                tool()
                    .riker.command(() => Ok(code))
                    .run([])
            );

        expect(codeFrom(1)).toBe(1);
        expect(codeFrom(0)).toBe(0);
    });

    it('refuses to run from a subcommand instance', () => {
        // Both of these are the caller misusing the builder rather than a user mistyping, which
        // is why they stay throws with a stack instead of becoming an Err.
        const sub = new Riker({ name: 'tool' }).command('init', 'Init.');
        expect(() => sub.run([])).toThrow(/non-root/);
        expect(() => new Riker({ name: 'tool' }).end()).toThrow(/No parent/);
    });

    it('awaits an async handler, and stays synchronous for everything before it', async () => {
        const asyncTool = tool().riker.command(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return Ok(3);
        });

        const pending = asyncTool.run([]);
        expect(pending).toBeInstanceOf(Promise);
        expect((await pending).unwrap()).toBe(3);

        // A parse error still comes back synchronously, not as a promise nobody awaited.
        expect(
            errorOf(
                tool()
                    .riker.command(async () => Ok(0))
                    .run(['--yolo'])
            )
        ).toMatch(/unknown option/);
    });
});

describe('subcommands', () => {
    function nested() {
        const { riker, out } = tool();
        const calls: Array<[string, unknown, string[]]> = [];
        const root = riker
            .flag({ name: 'dir', type: 'string', placeholder: '<path>', description: 'Where.' })
            .command('init', 'Initialize the repository.')
                .flag({ name: 'force', description: 'Overwrite.' })
                .command((flags, positionals) => {
                    calls.push(['init', flags, positionals]);
                    return Ok(0);
                })
                .end()
            .command('remote', 'Manage remotes.')
                .command('add', 'Add one.')
                    .flag({ name: 'fetch' })
                    .command((flags, positionals) => {
                        calls.push(['remote add', flags, positionals]);
                        return Ok(0);
                    })
                    .end()
                .end();
        return { root, out, calls };
    }

    it('dispatches to the selected subcommand', () => {
        const { root, calls } = nested();

        expect(codeOf(root.run(['init', '--force']))).toBe(0);
        expect(calls).toEqual([['init', { dir: undefined, force: true }, []]]);
    });

    it('accepts an inherited flag after the subcommand name', () => {
        const { root, calls } = nested();
        root.run(['init', '--dir', '/tmp', '--force']);

        expect(calls[0]?.[1]).toEqual({ dir: '/tmp', force: true });
    });

    it('descends into a nested subcommand', () => {
        const { root, calls } = nested();
        root.run(['remote', 'add', 'origin', '--fetch']);

        expect(calls).toEqual([['remote add', { dir: undefined, fetch: true }, ['origin']]]);
    });

    it('does not accept a sibling subcommand flag', () => {
        const { root } = nested();
        expect(errorOf(root.run(['init', '--fetch']))).toMatch(/unknown option "--fetch"/);
    });

    it('prints help instead of dispatching when a command has no handler', () => {
        const { root, out } = nested();

        expect(codeOf(root.run(['remote']))).toBe(0);
        expect(out.text()).toContain('add');
    });

    it('rejects a word that is not a subcommand', () => {
        const { root } = nested();
        expect(errorOf(root.run(['upgrade']))).toMatch(/unknown command "upgrade" — try --help/);
    });
});

describe('help and version', () => {
    function documented() {
        const { riker, out } = tool();
        const root = riker
            .flag({ name: 'dir', type: 'string', placeholder: '<path>', description: 'Target repository.' })
            .flag({ name: 'legacy', hidden: true })
            .command('init', 'Install it.')
                .flag({ name: 'force', description: 'Overwrite managed files.\nUse with care.' })
                .command(() => Ok(0))
                .end();
        return { root, out };
    }

    it('renders title, usage, commands and flags', () => {
        const { root, out } = documented();

        expect(codeOf(root.run(['--help']))).toBe(0);
        const text = out.text();
        expect(text).toContain('tool 1.2.3 — a test fixture');
        expect(text).toContain('Usage');
        expect(text).toContain('Commands');
        expect(text).toContain('  init             Install it.');
        expect(text).toContain('  --dir <path>     Target repository.');
        expect(text).toContain('  -h, --help');
    });

    it('names a command’s positionals in its usage line and in the command list', () => {
        const { out, riker } = tool();
        const root = riker
            .command('init', 'Install it.', '<repo>')
            .command(() => Ok(0))
            .end();

        expect(codeOf(root.run(['--help']))).toBe(0);
        expect(out.text()).toContain('init <repo>');

        expect(codeOf(root.run(['init', '--help']))).toBe(0);
        expect(out.text()).toMatch(/tool init <repo> \[flags\]/);
    });

    it('omits hidden flags and flags of commands not selected', () => {
        const { root, out } = documented();
        root.run(['-h']);

        expect(out.text()).not.toContain('legacy');
        expect(out.text()).not.toContain('--force');
    });

    it('shows a subcommand its own flags, with continuation lines aligned', () => {
        const { root, out } = documented();

        expect(codeOf(root.run(['init', '--help']))).toBe(0);
        const text = out.text();
        expect(text).toContain('tool init [flags]');
        expect(text).toContain('  --force          Overwrite managed files.');
        expect(text).toContain('\n                   Use with care.');
        // Inherited flags stay visible where the command accepts them.
        expect(text).toContain('--dir <path>');
    });

    it('prints help with no arguments when the root has no handler', () => {
        const { root, out } = documented();

        expect(codeOf(root.run([]))).toBe(0);
        expect(out.text()).toContain('Usage');
    });

    it('prints the bare version', () => {
        const { root, out } = documented();

        expect(codeOf(root.run(['--version']))).toBe(0);
        expect(out.text().trim()).toBe('1.2.3');
        expect(codeOf(root.run(['-v']))).toBe(0);
    });

    it('leaves --version out entirely when no version is configured', () => {
        const lines: string[] = [];
        const root = new Riker({ name: 'tool', log: (message) => lines.push(message) }).command('init', 'Go.').end();

        expect(errorOf(root.run(['--version']))).toMatch(/unknown option "--version"/);
        root.run(['--help']);
        expect(lines.join('\n')).not.toContain('--version');
    });

    it('uses the configured usage lines and epilog for the root only', () => {
        const lines: string[] = [];
        const root = new Riker({
            name: 'tool',
            usage: ['npx tool init [--force]'],
            usageNote: ' (on the host)',
            epilog: ['Notes', '  everything merges.'],
            log: (message) => lines.push(message),
        })
            .command('init', 'Install it.')
            .command(() => Ok(0))
            .end();

        root.run(['--help']);
        expect(lines.join('\n')).toContain('Usage (on the host)\n  npx tool init [--force]');
        expect(lines.join('\n')).toContain('everything merges.');

        lines.length = 0;
        root.run(['init', '--help']);
        expect(lines.join('\n')).toContain('  tool init [flags]');
        expect(lines.join('\n')).not.toContain('everything merges.');
    });

    it('derives usage from bin when the program is not invoked by its name', () => {
        const lines: string[] = [];
        const root = new Riker({ name: '@scope/tool', bin: 'npx @scope/tool@latest', log: (m) => lines.push(m) })
            .command('init', 'Install it.')
            .command(() => Ok(0))
            .end();

        root.run(['--help']);
        expect(lines.join('\n')).toContain('  npx @scope/tool@latest <command> [flags]');

        lines.length = 0;
        root.run(['init', '--help']);
        expect(lines.join('\n')).toContain('  npx @scope/tool@latest init [flags]');
    });
});

describe('the derived flags type', () => {
    it('maps each declaration to the value its handler receives', () => {
        expectTypeOf<Flags<[{ name: 'force' }]>>().toEqualTypeOf<{ force: boolean }>();
        expectTypeOf<Flags<[{ name: 'force'; default: true; allowNo: true }]>>().toEqualTypeOf<{ force: boolean }>();
        expectTypeOf<Flags<[{ name: 'dir'; type: 'string' }]>>().toEqualTypeOf<{ dir: string | undefined }>();
        expectTypeOf<Flags<[{ name: 'dir'; type: 'string'; default: '.' }]>>().toEqualTypeOf<{ dir: string }>();
        expectTypeOf<Flags<[{ name: 'dir'; type: 'string' }, { name: 'force' }]>>().toEqualTypeOf<{
            dir: string | undefined;
            force: boolean;
        }>();
    });

    it('accumulates through the chain, keeping literal names', () => {
        new Riker({ name: 'tool' })
            .flag({ name: 'dir', type: 'string' })
            .command('init', 'Install it.')
            .flag({ name: 'force' })
            .command((flags) => {
                expectTypeOf(flags).toEqualTypeOf<{ dir: string | undefined; force: boolean }>();
                // @ts-expect-error — not declared for this command.
                flags.nope;
                return Ok(0);
            })
            .end();
    });
});
