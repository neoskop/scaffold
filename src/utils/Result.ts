
import { inspect } from 'node:util';

export interface ResultBase<T, E> {
    unwrap(): T;
    unwrapErr(): E;
    unwrapOr<D>(defaultValue: D): T | D;
    unwrapOrElse<D>(fn: (err: E) => D): T | D;
    isOk(): this is OkResult<T, E>;
    isErr(): this is ErrResult<T, E>;
    map<D>(fn: (value: T) => D): Result<D, E>;
    mapErr<F>(fn: (err: E) => F): Result<T, F>;
    orElse<D, F>(fn: (err: E) => Result<D, F>): Result<T | D, F>;
    andThen<D, F>(fn: (value: T) => Result< D, F>): Result<D, E | F>;

    // The same four, for a callback that is asynchronous. The sync versions cannot take one: a
    // promise returned from `andThen` would become the Ok value instead of being awaited, so the
    // failure would be a Result wrapped in a Result rather than a type error. Each of these
    // awaits the callback and hands back a promise of the combined Result, which is what lets a
    // chain continue across an await instead of breaking into a branch per step.
    mapAsync<D>(fn: (value: T) => Promise<D>): Promise<Result<D, E>>;
    mapErrAsync<F>(fn: (err: E) => Promise<F>): Promise<Result<T, F>>;
    orElseAsync<D, F>(fn: (err: E) => Promise<Result<D, F>>): Promise<Result<T | D, F>>;
    andThenAsync<D, F>(fn: (value: T) => Promise<Result<D, F>>): Promise<Result<D, E | F>>;
}

export interface OkResult<T, E> extends ResultBase<T, E> {
    readonly value: T;
    castOk<D = T>(): OkResult<D, never>;
}

export interface ErrResult<T, E> extends ResultBase<T, E> {
    readonly err: E;
    castErr<F = E>(): ErrResult<never, F>;
}

export type Result<T, E> =  OkResult<T, E> | ErrResult<T, E>;


export class ResultImpl<T, E> implements ResultBase<T, E> {
    readonly #kind: 'ok' | 'err';
    readonly #value?: T;
    readonly #error?: E;

    private constructor(kind: 'ok' | 'err', value?: T, error?: E) {
        this.#kind = kind;
        this.#value = value;
        this.#error = error;
    }

    static Ok<T>(value: T): OkResult<T, never>;
    static Ok(): OkResult<void, never>;
    static Ok<T>(value?: T) {
        return new ResultImpl('ok', value) as unknown  as OkResult<T, never>;
    }

    static Err<E>(error: E) {
        return new ResultImpl('err', undefined, error) as unknown as ErrResult<never, E>;
    }

    get value(): T {
        return this.unwrap();
    }

    get err(): E {
        return this.unwrapErr();
    }

    isOk(): this is OkResult<T, E> {
        return this.#kind === 'ok';
    }

    isErr(): this is ErrResult<T, E> {
        return this.#kind === 'err';
    }

    castErr<F = E>(): ErrResult<never, F> {
        if (this.#kind !== 'err') {
            throw new Error(`Attempted to castErr an Ok value: ${inspect(this.#value)}`);
        }
        return this as unknown as ErrResult<never, F>;
    }

    private castOk<D = T>(): OkResult<D, never> {
        if (this.#kind !== 'ok') {
            throw new Error(`Attempted to castOk an Err value: ${inspect(this.#error)}`);
        }
        return this as unknown as OkResult<D, never>;
    }

    unwrap() {
        if (this.#kind === 'ok') {
            return this.#value as T;
        } else {
            throw new Error(`Attempted to unwrap an Err value: ${inspect(this.#error)}`);
        }
    }

    unwrapErr() {
        if (this.#kind === 'err') {
            return this.#error as E;
        } else {
            throw new Error(`Attempted to unwrapErr an Ok value: ${inspect(this.#value)}`);
        }
    }

    unwrapOr<D>(defaultValue: D): T | D {
        if (this.#kind === 'ok') {
            return this.value as T;
        } else {
            return defaultValue;
        }
    }

    unwrapOrElse<D>(fn: (err: E) => D): T | D {
        if (this.#kind === 'ok') {
            return this.value as T;
        } else {
            return fn(this.err as E);
        }
    }


    map<D>(fn: (value: T) => D): Result<D, E> {
        if (this.#kind === 'ok') {
            return ResultImpl.Ok(fn(this.value as T));
        } else {
            return this.castErr<E>();
        }
    }

    mapErr<F>(fn: (err: E) => F): Result<T, F> {
        if (this.#kind === 'err') {
            return ResultImpl.Err(fn(this.err as E));
        } else {
            return this.castOk<T>();
        }
    }

    orElse<D, F>(fn: (err: E) => Result<D, F>): Result<T | D, F> {
        if (this.#kind === 'err') {
            return fn(this.err as E);
        } else {
            return this.castOk<T | D>();
        }
    }

    andThen<D, F>(fn: (value: T) => Result< D, F>): Result<D, E | F> {
        if (this.#kind === 'ok') {
            return fn(this.value as T);
        } else {
            return this.castErr<E | F>();
        }
    }

    async mapAsync<D>(fn: (value: T) => Promise<D>): Promise<Result<D, E>> {
        if (this.#kind === 'ok') {
            return ResultImpl.Ok(await fn(this.value as T));
        } else {
            return this.castErr<E>();
        }
    }

    async mapErrAsync<F>(fn: (err: E) => Promise<F>): Promise<Result<T, F>> {
        if (this.#kind === 'err') {
            return ResultImpl.Err(await fn(this.err as E));
        } else {
            return this.castOk<T>();
        }
    }

    async orElseAsync<D, F>(fn: (err: E) => Promise<Result<D, F>>): Promise<Result<T | D, F>> {
        if (this.#kind === 'err') {
            return await fn(this.err as E);
        } else {
            return this.castOk<T | D>();
        }
    }

    async andThenAsync<D, F>(fn: (value: T) => Promise<Result<D, F>>): Promise<Result<D, E | F>> {
        if (this.#kind === 'ok') {
            return await fn(this.value as T);
        } else {
            return this.castErr<E | F>();
        }
    }

    [Symbol.for('nodejs.util.inspect.custom')]() {
        if (this.#kind === 'ok') {
            return `Ok(${inspect(this.value)})`;
        } else {
            return `Err(${inspect(this.err)})`;
        }
    }

}

const { Err, Ok } = ResultImpl;

export { Err, Ok };