-- Tables propres au banc sur le VPS (docs/ARCHITECTURE.md §16 et §17) : 2FA et sessions du compte
-- unique, journal des jobs BullMQ, état interne, mesure des verdicts (phase 7 bis).
-- Aucune donnée Supabase ne va ici (P10 : aucun verdict à migrer).

-- ---------------------------------------------------------------------------------------------
-- Compte unique : TOTP chiffré, codes de secours, sessions (§17.7)
-- ---------------------------------------------------------------------------------------------

-- Secret TOTP chiffré par l'API (secret-box de @raijin/server-security, clé propre au banc).
-- Jamais en clair ; `last_used_step` empêche le rejeu d'un code dans sa fenêtre.
CREATE TABLE public.bench_owner_totp (
    owner_id uuid NOT NULL,
    secret_encrypted text NOT NULL,
    enabled_at timestamp with time zone,
    last_used_step integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bench_owner_totp_pkey PRIMARY KEY (owner_id),
    CONSTRAINT bench_owner_totp_secret_check CHECK (((char_length(secret_encrypted) >= 16) AND (char_length(secret_encrypted) <= 1024))),
    CONSTRAINT bench_owner_totp_step_check CHECK (((last_used_step IS NULL) OR (last_used_step >= 0))),
    CONSTRAINT bench_owner_totp_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.bench_owner(id) ON DELETE CASCADE
);

-- Codes de secours à usage unique, stockés hachés (HMAC) : jamais en clair.
CREATE TABLE public.bench_recovery_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bench_recovery_codes_pkey PRIMARY KEY (id),
    CONSTRAINT bench_recovery_codes_hash_check CHECK (((char_length(code_hash) >= 32) AND (char_length(code_hash) <= 128))),
    CONSTRAINT bench_recovery_codes_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.bench_owner(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX bench_recovery_codes_code_hash_key ON public.bench_recovery_codes USING btree (code_hash);
CREATE INDEX bench_recovery_codes_owner_idx ON public.bench_recovery_codes USING btree (owner_id);

-- Sessions : seul le haché du jeton est stocké. Fin absolue `expires_at` (12 h au plus) ;
-- l'inactivité (2 h) se juge sur `last_seen_at`.
CREATE TABLE public.bench_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    token_hash text NOT NULL,
    user_agent text,
    ip_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    CONSTRAINT bench_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT bench_sessions_token_hash_check CHECK (((char_length(token_hash) >= 32) AND (char_length(token_hash) <= 128))),
    CONSTRAINT bench_sessions_user_agent_check CHECK (((user_agent IS NULL) OR (char_length(user_agent) <= 512))),
    CONSTRAINT bench_sessions_ip_hash_check CHECK (((ip_hash IS NULL) OR (char_length(ip_hash) <= 128))),
    CONSTRAINT bench_sessions_expiry_check CHECK ((expires_at > created_at) AND (expires_at <= (created_at + '12:00:00'::interval))),
    CONSTRAINT bench_sessions_revoked_check CHECK (((revoked_at IS NULL) = (revoked_reason IS NULL))),
    CONSTRAINT bench_sessions_revoked_reason_check CHECK (((revoked_reason IS NULL) OR (revoked_reason = ANY (ARRAY['logout'::text, 'logout_others'::text, 'password_change'::text, 'totp_reset'::text, 'idle'::text, 'expired'::text])))),
    CONSTRAINT bench_sessions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.bench_owner(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX bench_sessions_token_hash_key ON public.bench_sessions USING btree (token_hash);
CREATE INDEX bench_sessions_owner_idx ON public.bench_sessions USING btree (owner_id);
CREATE INDEX bench_sessions_expires_idx ON public.bench_sessions USING btree (expires_at);

-- ---------------------------------------------------------------------------------------------
-- Journal des jobs BullMQ (remplace pg_cron, docs/BENCH.md §3)
-- ---------------------------------------------------------------------------------------------

CREATE TYPE public.job_run_status AS ENUM ('running', 'success', 'failed', 'skipped');

-- Une ligne par exécution ; un chevauchement refusé par le verrou est écrit `skipped` (début = fin).
-- `error` : tronquée à 500 caractères et nettoyée de tout secret par le runner (bench-core).
CREATE TABLE public.job_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job text NOT NULL,
    status public.job_run_status DEFAULT 'running'::public.job_run_status NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    duration_ms integer,
    error text,
    details jsonb,
    CONSTRAINT job_runs_pkey PRIMARY KEY (id),
    CONSTRAINT job_runs_job_check CHECK ((job ~ '^[a-z][a-z0-9-]{1,39}$'::text)),
    CONSTRAINT job_runs_duration_check CHECK (((duration_ms IS NULL) OR (duration_ms >= 0))),
    CONSTRAINT job_runs_error_check CHECK (((error IS NULL) OR (char_length(error) <= 500))),
    CONSTRAINT job_runs_finished_check CHECK ((((status = 'running'::public.job_run_status) AND (finished_at IS NULL)) OR ((status <> 'running'::public.job_run_status) AND (finished_at IS NOT NULL) AND (finished_at >= started_at)))),
    CONSTRAINT job_runs_details_check CHECK (((details IS NULL) OR (pg_column_size(details) <= 8192)))
);
CREATE INDEX job_runs_job_started_idx ON public.job_runs USING btree (job, started_at DESC);
CREATE INDEX job_runs_started_idx ON public.job_runs USING btree (started_at);
CREATE INDEX job_runs_running_idx ON public.job_runs USING btree (job) WHERE (status = 'running'::public.job_run_status);

-- État interne clé → valeur (dernier niveau d'alerte de stockage, curseurs) : jamais de secret.
CREATE TABLE public.bench_state (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bench_state_pkey PRIMARY KEY (key),
    CONSTRAINT bench_state_key_check CHECK ((key ~ '^[a-z][a-z0-9_.:-]{0,63}$'::text)),
    CONSTRAINT bench_state_value_check CHECK ((pg_column_size(value) <= 8192))
);

-- ---------------------------------------------------------------------------------------------
-- Mesure des verdicts (docs/ARCHITECTURE.md §16, @raijin/bench-verdicts)
-- ---------------------------------------------------------------------------------------------

-- Un verdict par token analysé et par version du moteur (`verdict_at` = facts.observedAt).
-- `facts` : RiskFacts complets (rejeu des variantes) ; `facts_version` extrait pour filtrer le rejeu.
-- Supply brute u64 en numeric(20,0) (comparée en bigint côté code, jamais en number).
CREATE TABLE public.verdict_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mint text NOT NULL,
    verdict_at timestamp with time zone NOT NULL,
    engine_version text NOT NULL,
    verdict text NOT NULL,
    reason_codes text[] DEFAULT '{}'::text[] NOT NULL,
    flagged_checks text[] DEFAULT '{}'::text[] NOT NULL,
    baseline_price_usd numeric,
    baseline_liquidity_usd numeric,
    baseline_supply_raw numeric(20,0),
    facts jsonb NOT NULL,
    facts_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT verdict_records_pkey PRIMARY KEY (id),
    CONSTRAINT verdict_records_mint_check CHECK ((mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'::text)),
    CONSTRAINT verdict_records_engine_version_check CHECK ((engine_version ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'::text) AND (char_length(engine_version) <= 64)),
    CONSTRAINT verdict_records_verdict_check CHECK ((verdict = ANY (ARRAY['safe'::text, 'warn'::text, 'danger'::text]))),
    CONSTRAINT verdict_records_reason_codes_check CHECK ((cardinality(reason_codes) <= 40)),
    CONSTRAINT verdict_records_flagged_checks_check CHECK ((cardinality(flagged_checks) <= 9)),
    CONSTRAINT verdict_records_baseline_check CHECK (((baseline_price_usd IS NULL) OR (baseline_price_usd >= (0)::numeric)) AND ((baseline_liquidity_usd IS NULL) OR (baseline_liquidity_usd >= (0)::numeric)) AND ((baseline_supply_raw IS NULL) OR ((baseline_supply_raw >= (0)::numeric) AND (baseline_supply_raw <= '18446744073709551615'::numeric)))),
    CONSTRAINT verdict_records_facts_version_check CHECK ((char_length(facts_version) BETWEEN 1 AND 32)),
    CONSTRAINT verdict_records_facts_check CHECK ((jsonb_typeof(facts) = 'object'::text) AND (pg_column_size(facts) <= 65536))
);
CREATE UNIQUE INDEX verdict_records_mint_engine_key ON public.verdict_records USING btree (mint, engine_version);
CREATE INDEX verdict_records_verdict_at_idx ON public.verdict_records USING btree (verdict_at);
CREATE INDEX verdict_records_engine_verdict_at_idx ON public.verdict_records USING btree (engine_version, verdict_at);

-- Observation de suivi à un horizon (24 h / 72 h / 7 j), une seule par verdict et horizon.
-- `status` / `events` : classification pure (outcome.ts) mémorisée, recalculable.
CREATE TABLE public.follow_up_observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_id uuid NOT NULL,
    horizon text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    pool_found boolean,
    lp_removed boolean,
    price_usd numeric,
    liquidity_usd numeric,
    volume_24h_usd numeric,
    supply_raw numeric(20,0),
    status text,
    events text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT follow_up_observations_pkey PRIMARY KEY (id),
    CONSTRAINT follow_up_observations_horizon_check CHECK ((horizon = ANY (ARRAY['24h'::text, '72h'::text, '7d'::text]))),
    CONSTRAINT follow_up_observations_status_check CHECK (((status IS NULL) OR (status = ANY (ARRAY['rug'::text, 'dead'::text, 'alive'::text, 'unknown'::text])))),
    CONSTRAINT follow_up_observations_events_check CHECK ((events <@ ARRAY['LP_REMOVED'::text, 'PRICE_CRASH_90'::text, 'MINT_USED'::text, 'TOKEN_DEAD'::text])),
    CONSTRAINT follow_up_observations_values_check CHECK (((price_usd IS NULL) OR (price_usd >= (0)::numeric)) AND ((liquidity_usd IS NULL) OR (liquidity_usd >= (0)::numeric)) AND ((volume_24h_usd IS NULL) OR (volume_24h_usd >= (0)::numeric)) AND ((supply_raw IS NULL) OR ((supply_raw >= (0)::numeric) AND (supply_raw <= '18446744073709551615'::numeric)))),
    CONSTRAINT follow_up_observations_record_id_fkey FOREIGN KEY (record_id) REFERENCES public.verdict_records(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX follow_up_observations_record_horizon_key ON public.follow_up_observations USING btree (record_id, horizon);
CREATE INDEX follow_up_observations_observed_idx ON public.follow_up_observations USING btree (observed_at);

-- Agrégats quotidiens (conservés sans limite, calculés avant la purge, §16.5) : effectif par case
-- (jour du verdict, version, horizon, verdict, issue) ; `signal_counts` = effectif par code de raison
-- (`reason:<CODE>`) et contrôle signalé (`check:<id>`) dans la case, pour recalculer le lift.
CREATE TABLE public.daily_verdict_metrics (
    day date NOT NULL,
    engine_version text NOT NULL,
    horizon text NOT NULL,
    verdict text NOT NULL,
    outcome_status text NOT NULL,
    n integer NOT NULL,
    signal_counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT daily_verdict_metrics_pkey PRIMARY KEY (day, engine_version, horizon, verdict, outcome_status),
    CONSTRAINT daily_verdict_metrics_horizon_check CHECK ((horizon = ANY (ARRAY['24h'::text, '72h'::text, '7d'::text]))),
    CONSTRAINT daily_verdict_metrics_verdict_check CHECK ((verdict = ANY (ARRAY['safe'::text, 'warn'::text, 'danger'::text]))),
    CONSTRAINT daily_verdict_metrics_status_check CHECK ((outcome_status = ANY (ARRAY['rug'::text, 'dead'::text, 'alive'::text, 'unknown'::text]))),
    CONSTRAINT daily_verdict_metrics_n_check CHECK ((n >= 0)),
    CONSTRAINT daily_verdict_metrics_signals_check CHECK ((jsonb_typeof(signal_counts) = 'object'::text))
);
CREATE INDEX daily_verdict_metrics_engine_day_idx ON public.daily_verdict_metrics USING btree (engine_version, day);

-- Variantes du moteur (§16.4), testées derrière le drapeau `enabled` ; `reference` est réservé.
-- `fingerprint` : empreinte FNV-1a de la configuration résolue (variant.ts).
CREATE TABLE public.engine_variants (
    id text NOT NULL,
    label text NOT NULL,
    overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    reason_weights jsonb,
    fingerprint text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT engine_variants_pkey PRIMARY KEY (id),
    CONSTRAINT engine_variants_id_check CHECK (((id ~ '^[a-z0-9][a-z0-9-]{0,31}$'::text) AND (id <> 'reference'::text))),
    CONSTRAINT engine_variants_label_check CHECK (((char_length(label) >= 1) AND (char_length(label) <= 80))),
    CONSTRAINT engine_variants_overrides_check CHECK ((jsonb_typeof(overrides) = 'object'::text)),
    CONSTRAINT engine_variants_reason_weights_check CHECK (((reason_weights IS NULL) OR (jsonb_typeof(reason_weights) = 'object'::text))),
    CONSTRAINT engine_variants_fingerprint_check CHECK ((fingerprint ~ '^[0-9a-f]{8}$'::text))
);

-- Rejeu d'une variante contre la référence sur une période (rapport complet en JSON, `replayVariants`).
CREATE TABLE public.variant_replays (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    variant_id text NOT NULL,
    fingerprint text NOT NULL,
    reference_version text NOT NULL,
    variant_version text NOT NULL,
    period_from timestamp with time zone NOT NULL,
    period_to timestamp with time zone NOT NULL,
    records integer NOT NULL,
    skipped_records integer DEFAULT 0 NOT NULL,
    report jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT variant_replays_pkey PRIMARY KEY (id),
    CONSTRAINT variant_replays_fingerprint_check CHECK ((fingerprint ~ '^[0-9a-f]{8}$'::text)),
    CONSTRAINT variant_replays_period_check CHECK ((period_to >= period_from)),
    CONSTRAINT variant_replays_counts_check CHECK (((records >= 0) AND (skipped_records >= 0))),
    CONSTRAINT variant_replays_report_check CHECK ((jsonb_typeof(report) = 'object'::text)),
    CONSTRAINT variant_replays_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.engine_variants(id) ON DELETE CASCADE
);
CREATE INDEX variant_replays_variant_created_idx ON public.variant_replays USING btree (variant_id, created_at DESC);
