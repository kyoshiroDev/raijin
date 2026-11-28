// Lets `node --experimental-strip-types --test` load modules that import `npm:zod@^3.24` (Deno specifier).
// Under Deno: no-op (Deno resolves npm: natively). Under Node: registers zod-node-hook.mjs pointing at a zod
// copy already in the pnpm store (zod 3, or zod 4's `zod/v3` compatibility entry). No dependency is added.
import { existsSync, readdirSync } from 'node:fs';

function findZodV3(root: URL): string | null {
  const store = new URL('node_modules/.pnpm/', root);
  if (!existsSync(store)) return null;
  const dirs = readdirSync(store).filter((d) => /^zod@\d/.test(d)).sort().reverse();
  const candidates = [
    ...dirs.filter((d) => d.startsWith('zod@3.')).map((d) => `${d}/node_modules/zod/index.js`),
    ...dirs.filter((d) => !d.startsWith('zod@3.')).map((d) => `${d}/node_modules/zod/v3/index.js`),
  ];
  for (const c of candidates) {
    const url = new URL(c, store);
    if (existsSync(url)) return url.href;
  }
  return null;
}

/** true when `npm:zod` imports will resolve (always under Deno). */
export async function setupZodForNode(): Promise<boolean> {
  if ('Deno' in globalThis) return true;
  const zodUrl = findZodV3(new URL('../../../../', import.meta.url));
  if (!zodUrl) return false;
  const { register } = await import('node:module');
  register(new URL('./zod-node-hook.mjs', import.meta.url).href, { data: { zodUrl } });
  return true;
}
