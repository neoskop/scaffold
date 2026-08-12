import { inspect } from 'node:util';

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { Err, Ok, type ErrResult, type OkResult, type Result } from '../src/utils/Result.js';

// `Ok` returns OkResult<T, never> and `Err` returns ErrResult<never, E>, which is what lets either
// one satisfy a Result<T, E> annotation. Most tests want the union rather than the narrow variant —
// that is the type a real caller holds — so they start from these two helpers.
const ok = (value: number): Result<number, string> => Ok(value);
const err = (reason: string): Result<number, string> => Err(reason);

describe('construction', () => {
    it('reports an Ok as Ok and not Err', () => {
        const r = ok(1);
        expect(r.isOk()).toBe(true);
        expect(r.isErr()).toBe(false);
    });

    it('reports an Err as Err and not Ok', () => {
        const r = err('boom');
        expect(r.isErr()).toBe(true);
        expect(r.isOk()).toBe(false);
    });

    // The variant is carried by a separate #kind field, not inferred from the payload. Every one of
    // these would come out as Err if the check were a truthiness test on the value.
    it.each([undefined, null, 0, '', false, Number.NaN])('treats Ok(%o) as Ok', value => {
        expect(Ok(value).isOk()).toBe(true);
    });

    it('treats Err(undefined) as Err', () => {
        const r = Err(undefined);
        expect(r.isErr()).toBe(true);
        expect(r.unwrapErr()).toBeUndefined();
    });

    it('does not flatten a nested Result', () => {
        expect(Ok(Ok(1)).unwrap().unwrap()).toBe(1);
    });

    // Ok and Err are destructured off the class (`const { Err, Ok } = ResultImpl`), so they must not
    // depend on a `this` binding. Array.prototype.map hands them a bare reference plus two extra
    // arguments — a construction that breaks any static written as `new this(...)`.
    it('survives being passed as a bare function reference', () => {
        expect([1, 2, 3].map(Ok).map(r => r.unwrap())).toEqual([1, 2, 3]);
    });
});

describe('unwrap', () => {
    it('returns the value of an Ok', () => {
        expect(ok(42).unwrap()).toBe(42);
    });

    it('returns the error of an Err', () => {
        expect(err('boom').unwrapErr()).toBe('boom');
    });

    // The point of these two is as much *how* they fail as that they fail: a throw is catchable, so
    // the suite can assert on it and the process survives. An earlier revision called process.exit(1)
    // here, which took the test runner down with it and left this path permanently untestable.
    it('throws on unwrap of an Err', () => {
        expect(() => err('boom').unwrap()).toThrow(/Attempted to unwrap an Err value/);
    });

    it('throws on unwrapErr of an Ok', () => {
        expect(() => ok(1).unwrapErr()).toThrow(/Attempted to unwrapErr an Ok value/);
    });

    it('names the offending error in the message', () => {
        expect(() => err('boom').unwrap()).toThrow(/boom/);
    });

    it('carries a stack that points at the caller', () => {
        try {
            err('boom').unwrap();
            expect.unreachable('unwrap of an Err must throw');
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).stack).toContain('result.test.ts');
        }
    });
});

describe('value and err accessors', () => {
    it('exposes the payload on the matching variant', () => {
        const good = ok(1);
        const bad = err('boom');
        if (good.isOk()) expect(good.value).toBe(1);
        if (bad.isErr()) expect(bad.err).toBe('boom');
    });

    // Both getters delegate to unwrap, so reading the wrong one is a throw and not a silent
    // undefined. Only reachable by defeating the narrowing, which is what the casts stand in for.
    it('throws when read on the other variant', () => {
        expect(() => (err('boom') as OkResult<number, string>).value).toThrow(/unwrap an Err/);
        expect(() => (ok(1) as ErrResult<number, string>).err).toThrow(/unwrapErr an Ok/);
    });
});

// The re-tag every `if (r.isErr()) return ...` site needs: the ok type has to be discarded for the
// failure to satisfy the enclosing function's Result. Almost entirely a compile-time concern — the
// type assertions below are the real test, and these two pin down that nothing happens at runtime.
describe('castErr', () => {
    it('returns the same object rather than an equivalent Err', () => {
        const original = err('boom');
        if (!original.isErr()) return expect.unreachable('err() must produce an Err');
        expect(original.castErr()).toBe(original);
    });

    it('keeps the error reachable through the cast', () => {
        const original = err('boom');
        if (!original.isErr()) return expect.unreachable('err() must produce an Err');
        expect(original.castErr().unwrapErr()).toBe('boom');
    });

    // Only reachable by defeating the narrowing, as with the value/err getters. It matters that this
    // throws rather than casting: the result would claim isOk() while typed as an Err.
    it('throws when called on an Ok', () => {
        expect(() => (ok(1) as ErrResult<number, string>).castErr()).toThrow(/castErr an Ok value/);
    });
});

describe('unwrapOr and unwrapOrElse', () => {
    it('prefers the value of an Ok over the default', () => {
        expect(ok(1).unwrapOr(99)).toBe(1);
    });

    // 0 is the value most likely to be lost to a `||` somewhere in the branch.
    it('keeps a falsy Ok value instead of falling back', () => {
        expect(ok(0).unwrapOr(99)).toBe(0);
    });

    it('falls back to the default on an Err', () => {
        expect(err('boom').unwrapOr(99)).toBe(99);
    });

    it('does not call the fallback for an Ok', () => {
        const fallback = vi.fn(() => 99);
        expect(ok(1).unwrapOrElse(fallback)).toBe(1);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('calls the fallback for an Err', () => {
        const fallback = vi.fn(() => 99);
        expect(err('boom').unwrapOrElse(fallback)).toBe(99);
        expect(fallback).toHaveBeenCalledOnce();
    });

    // What lets a caller report the failure while producing a value, rather than having to branch
    // on isErr() just to reach the message.
    it('hands the error to the fallback', () => {
        expect(err('boom').unwrapOrElse((reason) => reason.length)).toBe(4);
        expect(err('boom').unwrapOrElse((reason) => `saw ${reason}`)).toBe('saw boom');
    });
});

describe('map', () => {
    it('applies the function to an Ok', () => {
        expect(ok(2).map(n => n * 2).unwrap()).toBe(4);
    });

    it('produces an Ok even when the function returns undefined', () => {
        const mapped = ok(1).map(() => undefined);
        expect(mapped.isOk()).toBe(true);
        expect(mapped.unwrap()).toBeUndefined();
    });

    // Short-circuiting returns `this` rather than rebuilding an equivalent Err. Asserting on
    // identity rather than equality is deliberate: it pins the no-allocation behaviour down.
    it('passes an Err through untouched, without calling the function', () => {
        const original = err('boom');
        const fn = vi.fn((n: number) => n * 2);
        expect(original.map(fn)).toBe(original);
        expect(fn).not.toHaveBeenCalled();
    });
});

describe('mapErr', () => {
    it('applies the function to an Err', () => {
        expect(err('boom').mapErr(e => e.toUpperCase()).unwrapErr()).toBe('BOOM');
    });

    it('passes an Ok through untouched, without calling the function', () => {
        const original = ok(1);
        const fn = vi.fn((e: string) => e.toUpperCase());
        expect(original.mapErr(fn)).toBe(original);
        expect(fn).not.toHaveBeenCalled();
    });
});

describe('andThen', () => {
    it('returns the Ok the function produced', () => {
        expect(ok(2).andThen(n => Ok(n + 1)).unwrap()).toBe(3);
    });

    it('returns the Err the function produced', () => {
        expect(ok(2).andThen(() => Err('rejected')).unwrapErr()).toBe('rejected');
    });

    it('passes an Err through untouched, without calling the function', () => {
        const original = err('boom');
        const fn = vi.fn(() => Ok(1));
        expect(original.andThen(fn)).toBe(original);
        expect(fn).not.toHaveBeenCalled();
    });

    // The first failure has to win, and it has to reach the end of the chain unmodified.
    it('short-circuits the rest of a chain at the first Err', () => {
        const second = vi.fn(() => Ok('unreachable'));
        const result = ok(1)
            .andThen(() => Err('first'))
            .andThen(second);
        expect(result.unwrapErr()).toBe('first');
        expect(second).not.toHaveBeenCalled();
    });
});

describe('orElse', () => {
    it('recovers from an Err with the function result', () => {
        expect(err('boom').orElse(e => Ok(e.length)).unwrap()).toBe(4);
    });

    it('can replace one Err with another', () => {
        expect(err('boom').orElse(() => Err('replaced')).unwrapErr()).toBe('replaced');
    });

    it('passes an Ok through untouched, without calling the function', () => {
        const original = ok(1);
        const fn = vi.fn(() => Ok(0));
        expect(original.orElse(fn)).toBe(original);
        expect(fn).not.toHaveBeenCalled();
    });
});

// The four async combinators. Each has to behave exactly like its synchronous twin, so these
// mirror the tests above — including asserting identity on the short-circuit, which is what proves
// the callback is skipped rather than awaited on a value that was never there.
describe('the async combinators', () => {
    const later = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 1));

    describe('mapAsync', () => {
        it('awaits the function and re-wraps the value', async () => {
            expect((await ok(2).mapAsync((n) => later(n * 2))).unwrap()).toBe(4);
        });

        it('passes an Err through untouched, without calling the function', async () => {
            const original = err('boom');
            const fn = vi.fn((n: number) => later(n * 2));
            expect(await original.mapAsync(fn)).toBe(original);
            expect(fn).not.toHaveBeenCalled();
        });
    });

    describe('mapErrAsync', () => {
        it('awaits the function and re-wraps the error', async () => {
            expect((await err('boom').mapErrAsync((e) => later(e.toUpperCase()))).unwrapErr()).toBe('BOOM');
        });

        it('passes an Ok through untouched, without calling the function', async () => {
            const original = ok(1);
            const fn = vi.fn((e: string) => later(e.toUpperCase()));
            expect(await original.mapErrAsync(fn)).toBe(original);
            expect(fn).not.toHaveBeenCalled();
        });
    });

    describe('andThenAsync', () => {
        it('returns the Ok the function resolved to', async () => {
            expect((await ok(2).andThenAsync((n) => later(Ok(n + 1)))).unwrap()).toBe(3);
        });

        it('returns the Err the function resolved to', async () => {
            expect((await ok(2).andThenAsync(() => later(Err('rejected')))).unwrapErr()).toBe('rejected');
        });

        it('passes an Err through untouched, without calling the function', async () => {
            const original = err('boom');
            const fn = vi.fn(() => later(Ok(1)));
            expect(await original.andThenAsync(fn)).toBe(original);
            expect(fn).not.toHaveBeenCalled();
        });

        // The reason this method exists: a chain that has to cross an await stays a chain.
        it('short-circuits a chain of awaits at the first Err', async () => {
            const third = vi.fn(() => later(Ok('unreachable')));
            const result = await (await ok(1).andThenAsync(() => later(Err('first')))).andThenAsync(third);

            expect(result.unwrapErr()).toBe('first');
            expect(third).not.toHaveBeenCalled();
        });
    });

    describe('orElseAsync', () => {
        it('recovers from an Err with what the function resolved to', async () => {
            expect((await err('boom').orElseAsync((e) => later(Ok(e.length)))).unwrap()).toBe(4);
        });

        it('can replace one Err with another', async () => {
            expect((await err('boom').orElseAsync(() => later(Err('replaced')))).unwrapErr()).toBe('replaced');
        });

        it('passes an Ok through untouched, without calling the function', async () => {
            const original = ok(1);
            const fn = vi.fn(() => later(Ok(0)));
            expect(await original.orElseAsync(fn)).toBe(original);
            expect(fn).not.toHaveBeenCalled();
        });
    });
});

describe('inspection output', () => {
    // Private #fields are invisible to util.inspect, so without the custom hook every Result in a
    // console.log or a failed-assertion diff prints as an empty `ResultImpl {}`.
    it('renders the variant and its payload', () => {
        expect(inspect(Ok(1))).toBe('Ok(1)');
        expect(inspect(Err('boom'))).toBe("Err('boom')");
    });

    it('renders inside a surrounding structure', () => {
        expect(inspect({ r: Ok([1, 2]) })).toBe('{ r: Ok([ 1, 2 ]) }');
    });
});

describe('a realistic pipeline', () => {
    const parsePort = (raw: string): Result<number, string> => {
        const n = Number(raw);
        if (!Number.isInteger(n)) return Err(`not an integer: ${raw}`);
        return n > 0 && n < 65536 ? Ok(n) : Err(`out of range: ${n}`);
    };

    it('carries a value through every stage', () => {
        expect(parsePort('8080').map(n => n + 1).andThen(Ok).unwrapOr(-1)).toBe(8081);
    });

    it.each([
        ['abc', 'not an integer: abc'],
        ['0', 'out of range: 0'],
        ['70000', 'out of range: 70000'],
    ])('reports %o as %o', (raw, expected) => {
        const result = parsePort(raw).map(n => n + 1);
        expect(result.isErr()).toBe(true);
        expect(result.unwrapErr()).toBe(expected);
    });
});

// Checked by `pnpm typecheck` rather than at runtime — tsconfig.json covers test/, and these calls
// erase to nothing. They exist because the inference, not the branching, is the fragile part: an
// earlier revision typed the variants as OkResult<T> and ErrResult<E>, which left E un-inferable and
// silently degraded `orElse` to Result<number, unknown>.
describe('type inference', () => {
    it('keeps both parameters through every combinator', () => {
        const r = ok(1);
        expectTypeOf(r.map(n => n * 2)).toEqualTypeOf<Result<number, string>>();
        expectTypeOf(r.mapErr(e => new Error(e))).toEqualTypeOf<Result<number, Error>>();
        expectTypeOf(r.orElse(() => Ok(0))).toEqualTypeOf<Result<number, never>>();
        expectTypeOf(r.unwrapOr('fallback')).toEqualTypeOf<number | string>();
        expectTypeOf(
            r.andThen(n => (n > 0 ? Ok(n) : Err('negative'))).andThen(n => (n < 9 ? Ok(String(n)) : Err(new RangeError('big')))),
        ).toEqualTypeOf<Result<string, string | RangeError>>();
    });

    it('keeps both parameters through the async combinators too', () => {
        const r = ok(1);
        expectTypeOf(r.mapAsync(async (n) => n * 2)).toEqualTypeOf<Promise<Result<number, string>>>();
        expectTypeOf(r.mapErrAsync(async (e) => new Error(e))).toEqualTypeOf<Promise<Result<number, Error>>>();
        expectTypeOf(r.orElseAsync(async () => Ok(0))).toEqualTypeOf<Promise<Result<number, never>>>();
        expectTypeOf(
            r.andThenAsync(async (n) => (n > 0 ? Ok(String(n)) : Err(new RangeError('big'))))
        ).toEqualTypeOf<Promise<Result<string, string | RangeError>>>();
    });

    it('hands unwrapOrElse the error type, not nothing', () => {
        expectTypeOf(ok(1).unwrapOrElse((reason) => reason.length)).toEqualTypeOf<number>();
        expectTypeOf(ok(1).unwrapOrElse((reason) => reason)).toEqualTypeOf<number | string>();
    });

    // What castErr is for: an Err out of a call that produced some other ok type has to satisfy the
    // enclosing signature. The `never` is the whole mechanism — an ErrResult that still carried the
    // inner ok type would be rejected here exactly as `return inner` is.
    it('drops the ok type so an Err fits any Result with the same error type', () => {
        const inner = (): Result<{ files: string[] }, string> => Err('boom');
        const outer = (): Result<number, string> => {
            const r = inner();
            if (r.isErr()) return r.castErr();
            return Ok(r.value.files.length);
        };

        const failed = inner();
        if (failed.isErr()) expectTypeOf(failed.castErr()).toEqualTypeOf<ErrResult<never, string>>();
        expect(outer().unwrapErr()).toBe('boom');
    });

    it('narrows to the payload of the matching variant', () => {
        const r = ok(1);
        if (r.isOk()) {
            expectTypeOf(r.value).toEqualTypeOf<number>();
        } else {
            expectTypeOf(r.err).toEqualTypeOf<string>();
        }
        if (r.isErr()) expectTypeOf(r.err).toEqualTypeOf<string>();
    });
});
