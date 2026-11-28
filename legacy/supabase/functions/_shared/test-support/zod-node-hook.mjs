// Node module hook (test-only): maps the Deno specifier `npm:zod@…` to a local zod v3 API.
// Deno resolves `npm:` itself and never loads this file.
let zodUrl = null;

export function initialize(data) {
  zodUrl = data && typeof data.zodUrl === 'string' ? data.zodUrl : null;
}

export async function resolve(specifier, context, next) {
  if (zodUrl && specifier.startsWith('npm:zod@')) return { url: zodUrl, shortCircuit: true };
  return next(specifier, context);
}
