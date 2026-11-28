#!/usr/bin/env node
// Generates the Angular 22 workspace with the official CLI, then lays Raijin's files on top.
// Usage: node scripts/bootstrap.mjs [supabase-project-ref]
// Cross-platform (Windows, macOS, Linux). Requires Node 22+ and pnpm (corepack enable).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'raijin';
const projectRef = process.argv[2] ?? '';
const run = (cmd, cwd = ROOT) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

if (existsSync(join(ROOT, 'angular.json'))) {
  console.log('angular.json already exists: bootstrap was already done.');
  process.exit(0);
}
if (projectRef && !/^[a-z0-9]{20}$/.test(projectRef)) {
  console.error('The Supabase project ref must be 20 lowercase letters/digits.');
  process.exit(1);
}

// 1. Official Angular 22 scaffold in a temp folder
const tmp = mkdtempSync(join(tmpdir(), 'raijin-'));
run(`pnpm dlx @angular/cli@22 new ${APP} --package-manager=pnpm --style=css --routing --ssr=false --skip-git --skip-install --defaults`, tmp);

// 2. Copy generated files without overwriting Raijin's own files
cpSync(join(tmp, APP), ROOT, { recursive: true, force: false, errorOnExist: false });
rmSync(tmp, { recursive: true, force: true });
for (const f of ['src/app/app.html', 'src/app/app.css', 'src/app/app.spec.ts']) rmSync(join(ROOT, f), { force: true });

// 3. Dependencies
run('pnpm install');
run('pnpm add @supabase/supabase-js');
run('pnpm add -D tailwindcss @tailwindcss/postcss postcss');
try {
  run('pnpm ng add angular-eslint --skip-confirmation');
} catch {
  console.warn('angular-eslint could not be added automatically; run `pnpm ng add angular-eslint` later.');
}

// 4. package.json scripts
const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.scripts = {
  ...pkg.scripts,
  prestart: 'node scripts/write-env.mjs',
  prebuild: 'node scripts/write-env.mjs',
  'test:ci': 'ng test --watch=false',
  'test:functions': 'deno test supabase/functions',
  'audit:prod': 'pnpm audit --prod',
};
pkg.engines = { node: '>=22' };
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// 5. angular.json: no inline critical CSS (its onload handler would violate the strict CSP)
const ngPath = join(ROOT, 'angular.json');
const ng = JSON.parse(readFileSync(ngPath, 'utf8'));
const prod = ng.projects[APP].architect.build.configurations.production;
prod.optimization = { scripts: true, styles: { minify: true, inlineCritical: false }, fonts: true };
writeFileSync(ngPath, JSON.stringify(ng, null, 2) + '\n');

// 6. Local environment file + Vercel CSP project ref
const envFile = join(ROOT, 'src/environments/environment.ts');
if (!existsSync(envFile)) copyFileSync(join(ROOT, 'src/environments/environment.example.ts'), envFile);
if (projectRef) {
  const vercel = join(ROOT, 'vercel.json');
  writeFileSync(vercel, readFileSync(vercel, 'utf8').replaceAll('YOUR_PROJECT_REF', projectRef));
}

// 7. First build
run('pnpm build');
console.log('\nRaijin is ready. Next: fill src/environments/environment.ts, then `pnpm start`.');
