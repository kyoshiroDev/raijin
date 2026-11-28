-- Schémas hors Prisma (lus en SQL brut, jamais modélisés dans schema.prisma) :
--   * `archive`    : copie facultative des tables mortes et des colonnes archivées de Supabase
--                    (P3/P4, `infra/bench-migrate.sh --with-archive`) ; lecture seule, lue par aucun code ;
--   * `shadow_ref` : instantané Supabase de la fenêtre comparée en mode ombre (§17.6,
--                    `infra/bench-migrate.sh --shadow-snapshot --since <date>`, lancé par l'utilisateur).
-- Les deux sont remplis par l'utilisateur `raijin_bench` lui-même ; l'API ne lit jamais Supabase.

CREATE SCHEMA IF NOT EXISTS archive;
COMMENT ON SCHEMA archive IS 'Historique Supabase facultatif (tables mortes, colonnes archivées). Lecture seule, non lu par le code.';

CREATE SCHEMA IF NOT EXISTS shadow_ref;
COMMENT ON SCHEMA shadow_ref IS 'Instantané Supabase pour la comparaison du mode ombre (bench-migrate.sh --shadow-snapshot).';

-- Mêmes colonnes que `public` (sans identité, défauts ni contraintes : copie brute des lignes
-- d'origine, identifiants compris). Rechargées entièrement à chaque instantané.
CREATE TABLE shadow_ref.tokens (LIKE public.tokens);
CREATE TABLE shadow_ref.token_snapshots (LIKE public.token_snapshots);
CREATE TABLE shadow_ref.scan_runs (LIKE public.scan_runs);
CREATE TABLE shadow_ref.alert_log (LIKE public.alert_log);
CREATE TABLE shadow_ref.paper_positions (LIKE public.paper_positions);
CREATE TABLE shadow_ref.signal_outcomes (LIKE public.signal_outcomes);
CREATE TABLE shadow_ref.preset_signals (LIKE public.preset_signals);

-- Colonne de date de la comparaison par jour (même choix des deux côtés).
CREATE INDEX shadow_ref_tokens_day_idx ON shadow_ref.tokens USING btree (first_seen_at);
CREATE INDEX shadow_ref_token_snapshots_day_idx ON shadow_ref.token_snapshots USING btree (captured_at);
CREATE INDEX shadow_ref_scan_runs_day_idx ON shadow_ref.scan_runs USING btree (started_at);
CREATE INDEX shadow_ref_alert_log_day_idx ON shadow_ref.alert_log USING btree (sent_at);
CREATE INDEX shadow_ref_paper_positions_day_idx ON shadow_ref.paper_positions USING btree (created_at);
CREATE INDEX shadow_ref_signal_outcomes_day_idx ON shadow_ref.signal_outcomes USING btree (detected_at);
CREATE INDEX shadow_ref_preset_signals_day_idx ON shadow_ref.preset_signals USING btree (detected_at);

-- Métadonnées de l'instantané : une ligne par import (la plus récente fait foi).
CREATE TABLE shadow_ref.snapshot_meta (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    taken_at timestamp with time zone DEFAULT now() NOT NULL,
    window_from timestamp with time zone NOT NULL,
    window_to timestamp with time zone NOT NULL,
    row_counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT snapshot_meta_pkey PRIMARY KEY (id),
    CONSTRAINT snapshot_meta_window_check CHECK ((window_to >= window_from) AND (window_to <= (window_from + '31 days'::interval))),
    CONSTRAINT snapshot_meta_counts_check CHECK ((jsonb_typeof(row_counts) = 'object'::text))
);
CREATE INDEX snapshot_meta_taken_idx ON shadow_ref.snapshot_meta USING btree (taken_at DESC);

-- Correspondance table → colonne de date, partagée par la comparaison (API) et bench-migrate.sh.
CREATE FUNCTION shadow_ref.day_column(p_table text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case p_table
    when 'tokens' then 'first_seen_at'
    when 'token_snapshots' then 'captured_at'
    when 'scan_runs' then 'started_at'
    when 'alert_log' then 'sent_at'
    when 'paper_positions' then 'created_at'
    when 'signal_outcomes' then 'detected_at'
    when 'preset_signals' then 'detected_at'
  end
$$;
