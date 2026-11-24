/**
 * Port Node (bench-engine) : les tests d'origine (`_shared/*_test.ts`, Deno / `node --test`) importent
 * `describe` / `it` depuis `node:test`. Sous Jest, `node:test` est redirigé ici (moduleNameMapper) : mêmes
 * fichiers de test, mêmes assertions (`node:assert/strict`), seule la signature `(nom, options, fn)` est adaptée.
 */
type Fn = (...args: unknown[]) => unknown;
interface Options {
  readonly skip?: unknown;
  readonly todo?: unknown;
  readonly only?: boolean;
}

function split(a?: Options | Fn, b?: Fn): { opts: Options; fn: Fn } {
  if (typeof a === 'function') return { opts: {}, fn: a };
  return { opts: a ?? {}, fn: b ?? (() => undefined) };
}

const context = { plan: () => undefined, diagnostic: () => undefined };

export function describe(name: string, a?: Options | Fn, b?: Fn): void {
  const { opts, fn } = split(a, b);
  const skip = Boolean(opts.skip) || Boolean(opts.todo);
  (skip ? globalThis.describe.skip : globalThis.describe)(name, () => {
    fn();
  });
}

export function it(name: string, a?: Options | Fn, b?: Fn): void {
  const { opts, fn } = split(a, b);
  const skip = Boolean(opts.skip) || Boolean(opts.todo);
  // Jest traite une fonction d'arité 1 comme un rappel `done` : toujours envelopper.
  (skip ? globalThis.it.skip : globalThis.it)(name, async () => {
    await fn(context);
  });
}

export const test = it;
