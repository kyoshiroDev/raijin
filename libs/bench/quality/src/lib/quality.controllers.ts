import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import {
  BENCH_ROUTES,
  SHADOW_MINT_SAMPLE_MAX,
  SHADOW_TABLES,
  shadowComparisonQuerySchema,
  shadowComparisonSchema,
  type ShadowComparison,
  type ShadowComparisonQuery,
  type ShadowDayRow,
  type ShadowTable,
} from '@raijin/bench-contracts';
import { BenchException, BenchZodPipe } from '@raijin/bench-core';
import { BenchSqlService, SHADOW_REF_DAY_COLUMNS } from '@raijin/bench-prisma';
import { buildQualityReport, type QualityReport } from '@raijin/bench-verdicts';
import { QualityStore } from './quality-store';

const DAY_MS = 86_400_000;
const QUALITY_DAYS = 365;
const QUALITY_MAX_RECORDS = 20_000;

/** Tables de `shadow_ref` sans colonne `mint` (pas de comparaison des mints). */
const WITHOUT_MINT: ReadonlySet<ShadowTable> = new Set(['scan_runs']);

/** Ligne du jour (pure) : écart en %, mints d'un seul côté (nombre + échantillon trié). */
export function shadowDayRow(
  table: ShadowTable,
  day: string,
  vps: number,
  ref: number,
  mints: { onlyVps: string[]; onlyRef: string[] } | null,
): ShadowDayRow {
  return {
    table,
    day,
    vps_rows: vps,
    ref_rows: ref,
    diff_pct: ref === 0 ? null : Math.round(((vps - ref) / ref) * 10_000) / 100,
    only_vps_count: mints ? mints.onlyVps.length : null,
    only_ref_count: mints ? mints.onlyRef.length : null,
    only_vps_sample: mints ? [...mints.onlyVps].sort().slice(0, SHADOW_MINT_SAMPLE_MAX) : [],
    only_ref_sample: mints ? [...mints.onlyRef].sort().slice(0, SHADOW_MINT_SAMPLE_MAX) : [],
  };
}

/** `GET /api/verdicts/quality` (rapport de justesse réel) et `GET /api/shadow/comparison` (mode ombre). */
@Controller()
export class BenchQualityController {
  constructor(
    private readonly sql: BenchSqlService,
    private readonly store: QualityStore,
  ) {}

  /**
   * Même `QualityReport` que la lib (`simulated: false`) : chaque proportion porte n, la période et l'intervalle de
   * Wilson à 95 % ; « échantillon insuffisant » sous 30 ; découpage chronologique calibration / validation.
   */
  @Get(BENCH_ROUTES.verdictQuality)
  async quality(): Promise<QualityReport> {
    const since = new Date(Date.now() - QUALITY_DAYS * DAY_MS).toISOString();
    const [measured, variants] = await Promise.all([this.store.loadMeasured(since, QUALITY_MAX_RECORDS), this.store.enabledVariants()]);
    return buildQualityReport({ simulated: false, ...measured }, variants);
  }

  @Get(BENCH_ROUTES.shadowComparison)
  async shadow(@Query(new BenchZodPipe(shadowComparisonQuerySchema)) query: ShadowComparisonQuery): Promise<ShadowComparison> {
    const from = `${query.from}T00:00:00Z`;
    const to = new Date(Date.parse(`${query.to}T00:00:00Z`) + DAY_MS).toISOString();
    const meta = await this.sql.query<{ taken_at: Date }>('select taken_at from shadow_ref.snapshot_meta order by taken_at desc limit 1');
    const rows: ShadowDayRow[] = [];
    for (const table of query.table ? [query.table] : SHADOW_TABLES) {
      const col = SHADOW_REF_DAY_COLUMNS[table];
      const counts = await this.sql.query<{ day: string; vps: string; ref: string }>(
        `with v as (select (${col} at time zone 'UTC')::date as day, count(*) as n from public.${table} where ${col} >= $1 and ${col} < $2 group by 1),
              r as (select (${col} at time zone 'UTC')::date as day, count(*) as n from shadow_ref.${table} where ${col} >= $1 and ${col} < $2 group by 1)
         select to_char(coalesce(v.day, r.day), 'YYYY-MM-DD') as day, coalesce(v.n, 0)::text as vps, coalesce(r.n, 0)::text as ref
           from v full join r on r.day = v.day order by 1`,
        [from, to],
      );
      const sides = new Map<string, { onlyVps: string[]; onlyRef: string[] }>();
      if (!WITHOUT_MINT.has(table)) {
        const mints = await this.sql.query<{ day: string; mint: string; in_vps: boolean; in_ref: boolean }>(
          `select to_char(d, 'YYYY-MM-DD') as day, mint, bool_or(src = 'v') as in_vps, bool_or(src = 'r') as in_ref from (
             select distinct (${col} at time zone 'UTC')::date as d, mint, 'v' as src from public.${table} where ${col} >= $1 and ${col} < $2
             union all
             select distinct (${col} at time zone 'UTC')::date as d, mint, 'r' as src from shadow_ref.${table} where ${col} >= $1 and ${col} < $2
           ) x group by d, mint having bool_or(src = 'v') <> bool_or(src = 'r')`,
          [from, to],
        );
        for (const m of mints.rows) {
          const entry = sides.get(m.day) ?? { onlyVps: [], onlyRef: [] };
          (m.in_vps ? entry.onlyVps : entry.onlyRef).push(m.mint);
          sides.set(m.day, entry);
        }
      }
      for (const c of counts.rows) {
        rows.push(shadowDayRow(table, c.day, Number(c.vps), Number(c.ref), WITHOUT_MINT.has(table) ? null : (sides.get(c.day) ?? { onlyVps: [], onlyRef: [] })));
      }
    }
    const takenAt = meta.rows[0]?.taken_at;
    const parsed = shadowComparisonSchema.safeParse({
      snapshot_at: takenAt ? new Date(takenAt).toISOString() : null,
      from: query.from,
      to: query.to,
      rows,
    });
    if (!parsed.success) throw new BenchException('INTERNAL_ERROR', HttpStatus.INTERNAL_SERVER_ERROR);
    return parsed.data;
  }
}
