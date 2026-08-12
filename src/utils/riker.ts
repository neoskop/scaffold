//
// Riker — a minimalistic argument parser.
//
// Declare the command tree once and parsing, dispatch, --help and --version all fall out of
// that declaration; there is no options table to keep in sync with a hand-written help text.
// The flag types accumulate as the chain is built, so a handler's `flags` argument is typed
// from the flags actually declared for its command.
//
//   new Riker({ name: 'tool', version: '1.0.0' })
//       .flag({ name: 'dir', type: 'string', placeholder: '<path>', description: 'Where.' })
//       .command('init', 'Initialize the repository.')
//           .flag({ name: 'force', description: 'Overwrite any existing files.' })
//           .command((flags) => doInit(flags.dir, flags.force))   // dir: string | undefined
//           .end()                                                // force: boolean
//       .run(process.argv.slice(2));
//
// A parse error is a Result, not a throw: `run` hands back an Err carrying the message, and a
// handler returns one the same way. The only throws left are the two builder misuses below —
// running from a subcommand, or `end()` at the root — which are bugs in the calling code rather
// than anything a user typed, and so deserve a stack trace.
//
// Out of scope on purpose: clustered shorts (`-abc`), repeatable flags (last one wins),
// required flags, and declared/validated positionals. Add them when something needs them.

import { neon } from './neon.js';
import { Err, Ok, type Result } from './Result.js';

interface FlagBase {
    name: string;
    /** Single character, without the dash. */
    short?: string;
    /** Omitted from --help when true. For undocumented aliases. */
    hidden?: boolean;
    description?: string;
}

export interface BooleanFlagOption extends FlagBase {
    type?: 'boolean';
    default?: boolean;
    /** Also accept `--no-<name>`, which sets it to false. */
    allowNo?: boolean;
}

export interface StringFlagOption extends FlagBase {
    type: 'string';
    default?: string;
    /** Shown after the flag in --help, e.g. `<path>`. */
    placeholder?: string;
}

export type FlagOption = BooleanFlagOption | StringFlagOption;

/** A boolean flag is never `undefined` — an absent one is `false`. */
type FlagValue<O extends FlagOption> = O extends { type: 'string' }
    ? O extends { default: string }
        ? string
        : string | undefined
    : boolean;

export type Flags<F extends readonly FlagOption[]> = {
    [O in F[number] as O['name']]: FlagValue<O>;
};

/** The Err is a message for the user; the Ok is the exit code. */
export type Handler<F extends readonly FlagOption[]> = (
    flags: Flags<F>,
    positionals: string[]
) => Result<number, string> | Promise<Result<number, string>>;

export interface RikerConfig {
    name: string;
    /** How the program is actually invoked, if that is not its name. Used in derived usage lines. */
    bin?: string;
    version?: string;
    description?: string;
    /** Verbatim usage lines for the root, replacing the derived one. */
    usage?: string[];
    /** Appended to the "Usage" heading, e.g. ` (run on the HOST)`. */
    usageNote?: string;
    /** Free-form sections printed after the flag list. Root help only. */
    epilog?: string[];
    log?: (message: string) => void;
    error?: (message: string) => void;
}

/** The declaration tree the builder writes and the parser walks. */
interface Spec {
    /** `null` for the root command. */
    name: string | null;
    description: string;
    /** This command's own flags; the parser also honours every ancestor's. */
    flags: FlagOption[];
    /**
     * Shown in the usage line, e.g. `<repo>`. Documentation only — positionals are still handed
     * to the handler unvalidated, because every command wants to phrase its own error.
     */
    positionals: string;
    commands: Spec[];
    handler: Handler<FlagOption[]> | null;
}

/** What one left-to-right pass over argv produced. */
interface Parsed {
    command: Spec;
    path: string[];
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
    /** Names of the flags Riker added itself, i.e. the ones no handler declared. */
    injected: string[];
}

const HELP: BooleanFlagOption = { name: 'help', short: 'h', description: 'Show this help.' };
const VERSION: BooleanFlagOption = { name: 'version', short: 'v', description: 'Print the version.' };

/** Two spaces of indent plus a label column, so descriptions all start at the same place. */
const LABEL_WIDTH = 17;
const INDENT = '  ';

function isStringFlag(flag: FlagOption): flag is StringFlagOption {
    return flag.type === 'string';
}

function label(flag: FlagOption): string {
    const short = flag.short ? `-${flag.short}, ` : '';
    const placeholder = isStringFlag(flag) && flag.placeholder ? ` ${flag.placeholder}` : '';
    return `${short}--${flag.name}${placeholder}`;
}

/** `  --dir <path>     Target repository.`, with continuation lines under the description. */
function describe(text: string, description: string): string {
    const [first = '', ...rest] = description.split('\n');
    const gap = ' '.repeat(INDENT.length + LABEL_WIDTH);
    const head = `${INDENT}${description ? text.padEnd(LABEL_WIDTH) : text}${first}`;
    return [head.trimEnd(), ...rest.map((line) => `${gap}${line}`.trimEnd())].join('\n');
}

export class Riker<F extends FlagOption[] = [], P = never> {
    private readonly spec: Spec;

    /**
     * Only the config argument is meant for callers; `spec` and `parent` are how
     * {@link Riker.command} builds a subcommand that shares this tree.
     */
    constructor(
        private readonly config: RikerConfig,
        spec?: Spec,
        private parent?: P
    ) {
        this.spec = spec ?? { name: null, description: '', flags: [], positionals: '', commands: [], handler: null };
    }

    flag<const O extends FlagOption>(options: O): Riker<[...F, O], P> {
        this.spec.flags.push(options as FlagOption);
        return this as unknown as Riker<[...F, O], P>;
    }

    /** Registers what runs when this command is selected. */
    command(handler: Handler<F>): this;
    /**
     * Declares a subcommand. Chain its flags, then `end()` to come back here. `positionals` is
     * the usage-line fragment, e.g. `<repo>` or `[name...]`.
     */
    command(name: string, description: string, positionals?: string): Riker<F, this>;
    command(nameOrHandler: string | Handler<F>, description = '', positionals = ''): unknown {
        if (typeof nameOrHandler !== 'string') {
            this.spec.handler = nameOrHandler as Handler<FlagOption[]>;
            return this;
        }
        const child: Spec = {
            name: nameOrHandler,
            description,
            flags: [],
            positionals,
            commands: [],
            handler: null,
        };
        this.spec.commands.push(child);
        return new Riker<F, this>(this.config, child, this);
    }

    end(): P {
        if (!this.parent) throw new Error('No parent to return to. This is the root Riker instance.');
        return this.parent;
    }

    /**
     * Parses `argv`, dispatches, and returns the exit code.
     *
     * Synchronous up to the handler, and only as asynchronous as the handler itself: parse
     * errors, `--help` and `--version` never become promises at all, which keeps them
     * inspectable without an await in the caller and in the tests.
     */
    run(argv: readonly string[]): Result<number, string> | Promise<Result<number, string>> {
        if (this.parent) throw new Error('Cannot run from a non-root Riker instance. Use the root instance to run.');

        const { log = console.log, version } = this.config;
        const parsed = this.parse(argv);
        if (parsed.isErr()) return parsed.castErr();
        const { command, values, positionals, path, injected } = parsed.value;

        if (values['help'] === true) {
            log(this.help(command, path));
            return Ok(0);
        }
        if (values['version'] === true && version !== undefined) {
            log(version);
            return Ok(0);
        }

        // --help/--version are ours unless they were declared, so they never reach a handler
        // as flags it did not ask for and its `flags` type does not mention.
        for (const name of injected) delete values[name];

        if (command.handler === null) {
            const [unknown] = positionals;
            if (unknown !== undefined) return Err(`unknown command "${unknown}" — try --help`);
            log(this.help(command, path));
            return Ok(0);
        }
        return command.handler(values as Flags<FlagOption[]>, positionals);
    }

    /**
     * One left-to-right pass. Flags are matched against the selected command's set — the root's
     * plus every subcommand descended into — so a global flag works before or after the command
     * name. The first bare word naming a subcommand selects it; anything else is a positional.
     */
    private parse(argv: readonly string[]): Result<Parsed, string> {
        const root = this.spec;
        const known = new Map<string, FlagOption>();
        const shorts = new Map<string, FlagOption>();
        const register = (flag: FlagOption): void => {
            known.set(flag.name, flag);
            if (flag.short) shorts.set(flag.short, flag);
        };
        const admit = (spec: Spec): void => spec.flags.forEach(register);

        admit(root);
        const injected: string[] = [];
        for (const auto of [HELP, ...(this.config.version === undefined ? [] : [VERSION])]) {
            if (known.has(auto.name)) continue;
            register(auto);
            injected.push(auto.name);
        }

        let command = root;
        const path: string[] = [];
        const values: Record<string, string | boolean | undefined> = {};
        const positionals: string[] = [];

        for (let index = 0; index < argv.length; index++) {
            const token = argv[index] as string;

            if (token === '--') {
                positionals.push(...argv.slice(index + 1));
                break;
            }

            if (token.startsWith('-') && token !== '-') {
                const long = token.startsWith('--');
                const [head, ...tail] = token.slice(long ? 2 : 1).split('=');
                const inline = tail.length > 0 ? tail.join('=') : undefined;
                const name = head ?? '';

                // `--no-x` only exists when x is a boolean flag that opted in, so an uninvited
                // one falls through to the same unknown-option error as a typo.
                const inverse = long && name.startsWith('no-') ? known.get(name.slice(3)) : undefined;
                const negated =
                    inverse && !isStringFlag(inverse) && (inverse.allowNo ?? false) ? inverse : undefined;
                const flag = (long ? known.get(name) : shorts.get(name)) ?? negated;
                if (!flag) return Err(`unknown option "${token}" — try --help`);

                if (isStringFlag(flag)) {
                    const value = inline ?? argv[index + 1];
                    if (value === undefined) return Err(`option "--${flag.name}" requires a value — try --help`);
                    if (inline === undefined) index++;
                    values[flag.name] = value;
                } else {
                    if (inline !== undefined) {
                        return Err(`option "${token.split('=')[0]}" does not take a value — try --help`);
                    }
                    values[flag.name] = flag !== negated;
                }
                continue;
            }

            const child = command.commands.find((candidate) => candidate.name === token);
            if (child && positionals.length === 0) {
                command = child;
                path.push(token);
                admit(child);
                continue;
            }
            positionals.push(token);
        }

        // Defaults last, so an explicit flag always wins regardless of where it appeared.
        for (const flag of known.values()) {
            if (flag.name in values) continue;
            values[flag.name] = isStringFlag(flag) ? flag.default : (flag.default ?? false);
        }

        return Ok({ command, path, values, positionals, injected });
    }

    /** Renders help for one command: its own flags plus every inherited one. */
    private help(command: Spec, path: string[]): string {
        const { name, version, description, usage, usageNote, epilog } = this.config;
        // Walk `path` back down from the root to collect the inherited flags in declaration order.
        const chain: Spec[] = [this.spec];
        for (const step of path) {
            const next = (chain[chain.length - 1] as Spec).commands.find((sub) => sub.name === step);
            if (!next) break;
            chain.push(next);
        }
        const flags = chain.flatMap((spec) => spec.flags);
        if (!flags.some((flag) => flag.name === HELP.name)) flags.push(HELP);
        if (version !== undefined && !flags.some((flag) => flag.name === VERSION.name)) flags.push(VERSION);

        const lines: string[] = [
            `${neon.bold`${name}`}${version ? ` ${version}` : ''}${description ? ` — ${description}` : ''}`,
            '',
            `${neon.bold`Usage`}${usageNote ?? ''}`,
        ];

        const invocation = [this.config.bin ?? name, ...path].join(' ');
        const takes = command.commands.length > 0 ? ' <command>' : command.positionals ? ` ${command.positionals}` : '';
        lines.push(
            ...(command === this.spec && usage
                ? usage.map((line) => `${INDENT}${line}`)
                : [`${INDENT}${invocation}${takes} [flags]`])
        );

        if (command.commands.length > 0) {
            lines.push('', neon.bold`Commands`);
            for (const sub of command.commands) {
                const label = sub.positionals ? `${sub.name} ${sub.positionals}` : (sub.name ?? '');
                lines.push(describe(label, sub.description));
            }
        }

        const shown = flags.filter((flag) => !(flag.hidden ?? false));
        if (shown.length > 0) {
            lines.push('', neon.bold`Flags`);
            for (const flag of shown) lines.push(describe(label(flag), flag.description ?? ''));
        }

        if (command === this.spec && epilog) lines.push('', ...epilog);
        lines.push('');
        return lines.join('\n');
    }
}
