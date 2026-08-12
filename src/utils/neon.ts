
const WEIGHT = {
    bold: 1,
    dim: 2
} as const;
type Weight = keyof typeof WEIGHT;

const COLOR = {
    black: 30,
    red: 31,
    green: 32,
    yellow: 33,
    blue: 34,
    magenta: 35,
    cyan: 36,
    white: 37,
    gray: 90,
    brightRed: 91,
    brightGreen: 92,
    brightYellow: 93,
    brightBlue: 94,
    brightMagenta: 95,
    brightCyan: 96,
    brightWhite: 97
} as const;
type Color = keyof typeof COLOR;

const BG_COLOR = {
    black: 40,
    red: 41,
    green: 42,
    yellow: 43,
    blue: 44,
    magenta: 45,
    cyan: 46,
    white: 47,
    gray: 100,
    brightRed: 101,
    brightGreen: 102,
    brightYellow: 103,
    brightBlue: 104,
    brightMagenta: 105,
    brightCyan: 106,
    brightWhite: 107
} as const  satisfies Record<Color, number>

interface Config {
    weight?: Weight;
    color?: Color;
    bgColor?: Color;
}

export type NeonObject = ((arr: TemplateStringsArray, ...args: any[]) => string) & {
    bold: NeonObject;
    dim: NeonObject;
} & {
    [K in Color]: NeonObject;
} & {
    [K in Color as `bg${Capitalize<K>}`]: NeonObject;
}

function Neon(config: Config): NeonObject  {
    const tag = (arr: TemplateStringsArray, ...args: any[]) => {
        const ansi = toAnsi(config);
        // Re-armed after every interpolation, so a nested style's reset does not end this
        // one — but not in front of an empty chunk, where there is nothing left to paint.
        const result = arr.reduce((acc, str, i) => acc + (str || i === 0 ? ansi : '') + str + (args[i] ?? ''), '');
        return ansi ? result + RESET : result;
    };

    // Built on access, and only once: every style is reachable from every other,
    // so building them eagerly would never terminate.
    const child = (extra: Config): PropertyDescriptor => {
        let built: NeonObject | undefined;
        return { get: () => (built ??= Neon({ ...config, ...extra })), enumerable: true, configurable: true };
    };

    return Object.defineProperties(tag, {
        bold: child({ weight: 'bold' }),
        dim: child({ weight: 'dim' }),
        ...Object.fromEntries(
            Object.keys(COLOR).flatMap((color) => [
                [color, child({ color: color as Color })],
                [`bg${color.charAt(0).toUpperCase() + color.slice(1)}`, child({ bgColor: color as Color })],
            ])
        ),
    }) as NeonObject;
}

export const neon = Neon({});

function toAnsi(config: Config): string {
    if((!process.stdout.isTTY && !process.env.FORCE_COLOR) || process.env.NO_COLOR) return '';
    const weight = config.weight ? WEIGHT[config.weight] : undefined;
    const color = config.color ? COLOR[config.color] : undefined;
    const bgColor = config.bgColor ? BG_COLOR[config.bgColor] : undefined;

    const codes = [weight, color, bgColor].filter((code) => code !== undefined);

    if (codes.length === 0) {
        return '';
    }

    return `${ESC}${codes.join(';')}m`;
}

const ESC = '\x1b[';
const RESET = ESC + '0m';