import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BENCH_JOB_NAMES,
  JOB_ERROR_MAX_LENGTH,
  SHADOW_TABLES,
} from '@raijin/bench-contracts';
import {
  BENCH_TABLES,
  DEAD_TABLES,
  DROPPED_ARCHIVED_COLUMNS,
  PORTED_TABLES,
  SHADOW_REF_DAY_COLUMNS,
} from './bench-tables';

/**
 * Contrôles statiques des migrations (sans base) : périmètre de l'inventaire docs/BENCH.md, absence
 * de tout reliquat Supabase, et fonctions SQL portées à l'identique (P5) par comparaison avec leur
 * dernière définition dans legacy/supabase/migrations (tant que ce dossier de référence existe).
 */

const ROOT = resolve(__dirname, '../..');
const MIGRATIONS_DIR = join(ROOT, 'prisma/migrations');
const LEGACY_DIR = resolve(ROOT, '../../../legacy/supabase/migrations');

function readMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'),
    }));
}

const migrations = readMigrations();
const allSql = migrations.map((m) => m.sql).join('\n');
const ported = migrations[0]?.sql ?? '';

/** Partie exécutable (commentaires `--` retirés). */
function code(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** Tables créées dans un schéma, d'après le SQL. */
function createdTables(sql: string, schema: string): string[] {
  const re = new RegExp(`CREATE TABLE ${schema}\\.(\\w+)`, 'gi');
  return [...sql.matchAll(re)].map((m) => m[1] ?? '').sort();
}

/** Corps de chaque fonction (texte entre les délimiteurs dollar), par nom ; la dernière définition gagne. */
function functionBodies(sql: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const re = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi;
  for (const match of sql.matchAll(re)) {
    const name = (match[1] ?? '').toLowerCase();
    const rest = sql.slice((match.index ?? 0) + match[0].length);
    const open = /\bas\s+(\$[a-z_]*\$)/i.exec(rest);
    if (!open || open.index === undefined) continue;
    const tag = open[1] ?? '$$';
    const start = open.index + open[0].length;
    const end = rest.indexOf(tag, start);
    if (end < 0) continue;
    bodies.set(name, rest.slice(start, end));
  }
  return bodies;
}

describe('migrations de raijin_bench', () => {
  it('trois migrations ordonnées, toutes non vides', () => {
    expect(migrations.map((m) => m.name)).toEqual([
      '20261124000000_ported_tables',
      '20261124000100_bench_runtime',
      '20261124000200_archive_shadow_ref',
    ]);
    for (const m of migrations) expect(m.sql.length).toBeGreaterThan(500);
  });

  it('public : exactement les 21 tables portées et les tables du VPS, aucune table morte', () => {
    expect(PORTED_TABLES).toHaveLength(21);
    expect(createdTables(allSql, 'public')).toEqual(
      [...PORTED_TABLES, ...BENCH_TABLES].sort(),
    );
    for (const dead of DEAD_TABLES)
      expect(allSql).not.toMatch(
        new RegExp(`CREATE TABLE public\\.${dead}\\b`),
      );
    expect(code(allSql)).not.toMatch(/CREATE (OR REPLACE )?VIEW/i);
  });

  it('colonnes archivées retirées de public (P3)', () => {
    for (const [table, columns] of Object.entries(DROPPED_ARCHIVED_COLUMNS)) {
      const ddl = new RegExp(
        `CREATE TABLE public\\.${table} \\(([\\s\\S]*?)\\n\\);`,
      ).exec(ported)?.[1];
      expect(ddl).toBeDefined();
      for (const column of columns ?? [])
        expect(ddl).not.toMatch(new RegExp(`^\\s+${column}\\s`, 'm'));
    }
    // Gardées car encore lues par le code porté.
    expect(ported).toMatch(/^\s+liquidity_jup_usd numeric/m);
  });

  it('aucun reliquat Supabase : auth, RLS, policies, grants, Realtime, Vault, pg_cron, pg_net', () => {
    const sql = code(allSql);
    expect(sql).not.toMatch(/\bauth\.(uid|users|role|jwt)\b/);
    expect(sql).not.toMatch(
      /ROW LEVEL SECURITY|CREATE POLICY|\bGRANT\b|\bREVOKE\b|PUBLICATION/i,
    );
    // « not authenticated » reste le message d'erreur d'origine des RPC (code 42501).
    expect(sql).not.toMatch(
      /\b(anon|service_role|supabase_\w+)\b|\bto authenticated\b/i,
    );
    expect(sql).not.toMatch(/\b(vault|cron|net)\.\w+/);
    expect(sql).not.toMatch(/CREATE EXTENSION/i);
    expect(sql).not.toMatch(/^\\/m);
  });

  it('compte unique : clés vers bench_owner et propriétaire par bench_owner_id()', () => {
    const fks = [
      ...ported.matchAll(
        /FOREIGN KEY \((\w+)\) REFERENCES public\.bench_owner\(id\)/g,
      ),
    ].map((m) => m[1]);
    // 7 tables à user_id (push, réglages, journal, carnets, positions, jambes) + backtest_runs.requested_by.
    expect(fks.sort()).toEqual([
      'requested_by',
      'user_id',
      'user_id',
      'user_id',
      'user_id',
      'user_id',
      'user_id',
    ]);
    expect(ported).toMatch(
      /CREATE FUNCTION public\.bench_owner_id\(\) RETURNS uuid/,
    );
  });

  it('déclencheurs portés (8 : le 9e visait early_outcomes, table morte)', () => {
    const triggers = [
      ...ported.matchAll(/CREATE TRIGGER (\w+) BEFORE (\w+) ON public\.(\w+)/g),
    ].map((m) => `${m[3]}:${m[1]}`);
    expect(triggers.sort()).toEqual([
      'alert_settings:alert_settings_touch',
      'backtest_events:backtest_events_first_candle_checkpoint',
      'paper_positions:paper_positions_before_insert',
      'preset_signals:preset_signals_first_candle_checkpoint',
      'preset_signals:preset_signals_first_label_checkpoint',
      'push_subscriptions:push_subscriptions_cap',
      'signal_outcomes:signal_outcomes_first_candle_checkpoint',
      'signal_outcomes:signal_outcomes_first_label_checkpoint',
    ]);
  });

  it('shadow_ref : les tables comparées, plus les métadonnées d’instantané', () => {
    const last = migrations[2]?.sql ?? '';
    expect(createdTables(last, 'shadow_ref')).toEqual(
      [...Object.keys(SHADOW_REF_DAY_COLUMNS), 'snapshot_meta'].sort(),
    );
    for (const [table, column] of Object.entries(SHADOW_REF_DAY_COLUMNS)) {
      expect(last).toContain(`ON shadow_ref.${table} USING btree (${column})`);
      expect(last).toContain(`when '${table}' then '${column}'`);
    }
    expect(last).toMatch(/CREATE SCHEMA IF NOT EXISTS archive;/);
  });

  it('contrats du banc alignés sur le SQL : noms de jobs, longueur d’erreur, tables comparées', () => {
    const runtime = migrations[1]?.sql ?? '';
    const jobPattern = /job ~ '(\^[^']+)'/.exec(runtime)?.[1];
    expect(jobPattern).toBeDefined();
    for (const job of BENCH_JOB_NAMES)
      expect(job).toMatch(new RegExp(jobPattern ?? '$^'));
    expect(runtime).toContain(`char_length(error) <= ${JOB_ERROR_MAX_LENGTH}`);
    expect(runtime).toContain(
      "ENUM ('running', 'success', 'failed', 'skipped')",
    );
    expect([...SHADOW_TABLES].sort()).toEqual(
      Object.keys(SHADOW_REF_DAY_COLUMNS).sort(),
    );
  });

  const legacyAvailable = existsSync(LEGACY_DIR);
  (legacyAvailable ? describe : describe.skip)(
    'fonctions SQL identiques à Supabase (référence legacy/)',
    () => {
      const legacySql = legacyAvailable
        ? readdirSync(LEGACY_DIR)
            .filter((f) => f.endsWith('.sql'))
            .sort()
            .map((f) => readFileSync(join(LEGACY_DIR, f), 'utf8'))
            .join('\n')
        : '';
      const legacy = functionBodies(legacySql);
      const bench = functionBodies(ported);

      it('27 fonctions vivantes portées (dont 2 de déclencheur gardées en SQL) + bench_owner_id ; claim_test_push abandonnée', () => {
        expect(bench.has('claim_test_push')).toBe(false);
        expect(bench.has('bench_owner_id')).toBe(true);
        expect(bench.size).toBe(28);
        for (const name of bench.keys())
          if (name !== 'bench_owner_id') expect(legacy.has(name)).toBe(true);
      });

      it.each(
        [...functionBodies(ported).keys()].filter(
          (n) => n !== 'bench_owner_id',
        ),
      )('%s : corps inchangé (auth.uid() → bench_owner_id())', (name) => {
        const expected = (legacy.get(name) ?? '').replace(
          /auth\.uid\(\)/g,
          'public.bench_owner_id()',
        );
        expect(bench.get(name)).toBe(expected);
      });
    },
  );
});
