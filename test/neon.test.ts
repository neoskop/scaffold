import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { neon } from '../src/utils/neon.js';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

/** The codes the tag is expected to emit, spelled out rather than imported. */
const FG = {
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
    brightWhite: 97,
} as const;

type ColorName = keyof typeof FG;
const COLORS = Object.entries(FG) as Array<[ColorName, number]>;
const bgOf = (name: ColorName) => `bg${name.charAt(0).toUpperCase()}${name.slice(1)}` as keyof typeof neon;

const wasTty = process.stdout.isTTY;

beforeEach(() => {
    // Colour is decided per call, so every switch is set explicitly for every test.
    process.stdout.isTTY = true;
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('NO_COLOR', undefined);
});

afterEach(() => {
    process.stdout.isTTY = wasTty;
    vi.unstubAllEnvs();
});

describe('deciding whether to colour at all', () => {
    it('emits nothing but the text when stdout is not a TTY', () => {
        process.stdout.isTTY = false;

        expect(neon.bold.red.bgWhite`danger`).toBe('danger');
    });

    it('leaves no stray reset behind when colour is off', () => {
        process.stdout.isTTY = false;

        expect(neon.red`danger`).not.toContain(ESC);
    });

    it('colours a pipe anyway when FORCE_COLOR is set', () => {
        process.stdout.isTTY = false;
        vi.stubEnv('FORCE_COLOR', '1');

        expect(neon.red`danger`).toBe(`${ESC}31mdanger${RESET}`);
    });

    it('stays out of the way when NO_COLOR is set, even on a TTY', () => {
        vi.stubEnv('NO_COLOR', '1');

        expect(neon.bold.red`danger`).toBe('danger');
    });

    it('lets NO_COLOR beat FORCE_COLOR', () => {
        vi.stubEnv('FORCE_COLOR', '1');
        vi.stubEnv('NO_COLOR', '1');

        expect(neon.red`danger`).toBe('danger');
    });

    it('decides per call, not once at import', () => {
        const red = neon.red;

        process.stdout.isTTY = true;
        expect(red`x`).toBe(`${ESC}31mx${RESET}`);

        process.stdout.isTTY = false;
        expect(red`x`).toBe('x');
    });

    it('passes text through untouched when no style was selected', () => {
        expect(neon`plain`).toBe('plain');
    });
});

describe('single styles', () => {
    it.each(COLORS)('paints the foreground %s', (name, code) => {
        expect(neon[name]`x`).toBe(`${ESC}${code}mx${RESET}`);
    });

    it.each(COLORS)('paints the background %s ten codes above the foreground', (name, code) => {
        expect(neon[bgOf(name)]`x`).toBe(`${ESC}${code + 10}mx${RESET}`);
    });

    it('sets the weight', () => {
        expect(neon.bold`x`).toBe(`${ESC}1mx${RESET}`);
        expect(neon.dim`x`).toBe(`${ESC}2mx${RESET}`);
    });

    it('exposes every colour as both a foreground and a background accessor', () => {
        for (const [name] of COLORS) {
            expect(neon[name], name).toBeTypeOf('function');
            expect(neon[bgOf(name)], bgOf(name)).toBeTypeOf('function');
        }
    });
});

describe('combining styles', () => {
    it('orders the codes weight, foreground, background regardless of how they were chained', () => {
        const expected = `${ESC}1;31;47mx${RESET}`;

        expect(neon.bold.red.bgWhite`x`).toBe(expected);
        expect(neon.bgWhite.red.bold`x`).toBe(expected);
        expect(neon.red.bgWhite.bold`x`).toBe(expected);
    });

    it('lets the last style of a kind win', () => {
        expect(neon.red.green`x`).toBe(`${ESC}32mx${RESET}`);
        expect(neon.bold.dim`x`).toBe(`${ESC}2mx${RESET}`);
        expect(neon.bgRed.bgBlue`x`).toBe(`${ESC}44mx${RESET}`);
    });

    it('keeps a foreground and a background of the same colour apart', () => {
        expect(neon.red.bgRed`x`).toBe(`${ESC}31;41mx${RESET}`);
    });

    it('never mutates the style it was chained from', () => {
        const red = neon.red;
        const loud = red.bold.bgWhite;

        expect(loud`x`).toBe(`${ESC}1;31;47mx${RESET}`);
        expect(red`x`).toBe(`${ESC}31mx${RESET}`);
        expect(neon`x`).toBe('x');
    });

    it('survives a long chain', () => {
        expect(neon.red.bold.bgWhite.dim.green.brightBlue`x`).toBe(`${ESC}2;94;47mx${RESET}`);
    });

    it('can be hoisted once and reused', () => {
        const error = neon.bold.red;

        expect(error`first`).toBe(`${ESC}1;31mfirst${RESET}`);
        expect(error`second`).toBe(`${ESC}1;31msecond${RESET}`);
    });
});

describe('the template tag', () => {
    it('interpolates values into the styled run', () => {
        expect(neon.red`a${1}b`).toBe(`${ESC}31ma1${ESC}31mb${RESET}`);
    });

    it('re-arms the style after each interpolation, so a nested style restores the outer one', () => {
        vi.stubEnv('FORCE_COLOR', '1');

        expect(neon.red`a ${neon.green`b`} c`).toBe(
            `${ESC}31ma ${ESC}32mb${RESET}${ESC}31m c${RESET}`
        );
    });

    it('does not re-arm in front of an empty chunk, where there is nothing left to paint', () => {
        // The common `style`${value}`` case: one code in, one reset out, nothing in between.
        expect(neon.red`${'x'}`).toBe(`${ESC}31mx${RESET}`);
        expect(neon.bold`${'a'}@${'b'}`).toBe(`${ESC}1ma${ESC}1m@b${RESET}`);
    });

    it('renders null and undefined as nothing rather than as their names', () => {
        expect(neon.red`[${undefined}${null}]`).toBe(`${ESC}31m[${ESC}31m]${RESET}`);
    });

    it('keeps falsy values that are not nullish', () => {
        expect(neon.red`${0}${false}${''}`).toBe(`${ESC}31m0false${RESET}`);
    });

    it('handles an empty template', () => {
        expect(neon.red``).toBe(`${ESC}31m${RESET}`);
    });

    it('styles a multi-line string as one run', () => {
        expect(neon.dim`one\ntwo`).toBe(`${ESC}2mone\ntwo${RESET}`);
    });
});
