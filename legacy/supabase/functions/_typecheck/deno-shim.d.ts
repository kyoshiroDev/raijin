// Minimal Deno globals so `tsc` can type-check the Edge Functions without a Deno install.
// Only what the functions use. Not shipped (folder starts with "_" and is never imported by a function).
declare namespace Deno {
  const env: { get(key: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
}
