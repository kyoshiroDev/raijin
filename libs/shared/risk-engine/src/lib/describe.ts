import type {
  AnalysisCheckId,
  CheckMetric,
  RiskAssessment,
  RiskCheckOutcome,
  RiskFacts,
  RiskReasonCode,
} from '@raijin/shared-contracts';

/**
 * Phrases françaises (tutoiement, factuelles, sans conseil d'investissement ni promesse) associées
 * aux codes de raison. Une phrase par code, 200 caractères max (contrat `analysisCheckSchema.summary`).
 * Rédigées par Raijin : aucune donnée externe n'y est interpolée.
 */
export const REASON_SENTENCES: Readonly<Record<RiskReasonCode, string>> = {
  MINT_AUTHORITY_ACTIVE: "L'autorité de mint est active : quelqu'un peut encore créer de nouveaux tokens et diluer ta part.",
  FREEZE_AUTHORITY_ACTIVE: "L'autorité de freeze est active : quelqu'un peut bloquer tes tokens dans ton wallet.",
  FREEZE_AUTHORITY_KNOWN_ISSUER:
    "L'émetteur régulé de ce token garde une autorité de freeze, comme l'exige sa réglementation. Il peut bloquer des tokens.",
  TOKEN2022_TRANSFER_FEE: 'Ce token prélève des frais à chaque transfert : tu en perds une partie à la revente.',
  TOKEN2022_PERMANENT_DELEGATE:
    "Un délégué permanent peut déplacer ou brûler les tokens de n'importe quel holder, y compris les tiens.",
  TOKEN2022_TRANSFER_HOOK: 'Un programme externe est appelé à chaque transfert : il peut limiter ou bloquer les reventes.',
  TOKEN2022_NON_TRANSFERABLE: 'Ce token ne peut pas être transféré : il est impossible de le revendre.',
  LIQUIDITY_REMOVED: 'La liquidité a été retirée du pool : le token ne peut presque plus être revendu.',
  LIQUIDITY_LOW: 'La liquidité est faible : une petite vente peut faire chuter fortement le prix.',
  LP_NOT_BURNED_OR_LOCKED: "La majorité de la liquidité n'est ni brûlée ni verrouillée : elle peut être retirée à tout moment.",
  TOP10_CONCENTRATION_HIGH: 'Les 10 plus gros holders détiennent une grande part du supply : leurs ventes pèseraient lourd sur le prix.',
  SINGLE_HOLDER_ABOVE_THRESHOLD: 'Un seul wallet détient une part importante du supply : il peut faire chuter le prix en vendant.',
  SELL_NO_ROUTE: "Aucune route de vente n'a été trouvée : tu risques de ne pas pouvoir revendre ce token.",
  SELL_TAX_HIGH: 'Le devis de vente révèle une taxe implicite élevée : tu récupérerais nettement moins que le prix affiché.',
  SELL_PRICE_IMPACT_HIGH: 'Revendre un petit montant fait déjà bouger le prix de façon importante.',
  METADATA_MUTABLE: 'Le nom, le symbole ou le logo peuvent encore être modifiés par leur propriétaire.',
  TOKEN_VERY_NEW: 'Ce token a été créé très récemment : il a peu d’historique.',
  POOL_VERY_NEW: 'Le pool de liquidité vient d’être créé : il a peu d’historique.',
  CREATOR_PRIOR_RUGS: 'Le créateur a déjà lancé des tokens qui ont subi un rug.',
  CREATOR_MANY_DEAD_TOKENS: 'Le créateur a déjà lancé plusieurs tokens aujourd’hui morts ou abandonnés.',
  RUGCHECK_RUGGED: 'RugCheck considère ce token comme victime d’un rug.',
  RUGCHECK_DANGER: 'RugCheck signale au moins un risque de niveau danger.',
  RUGCHECK_WARN: 'RugCheck signale au moins un point d’attention.',
  DATA_UNAVAILABLE: "La source n'a pas répondu à temps : ce contrôle n'a pas pu être vérifié.",
};

/** Phrases des contrôles sans signal (statut « ok »). */
export const OK_SENTENCES: Readonly<Record<AnalysisCheckId, string>> = {
  mint_authority: "L'autorité de mint est révoquée : personne ne peut créer de nouveaux tokens.",
  freeze_authority: "L'autorité de freeze est révoquée : personne ne peut bloquer tes tokens.",
  liquidity: 'La liquidité est suffisante et majoritairement brûlée ou verrouillée.',
  holder_concentration: 'Le supply est réparti : aucun wallet ne dépasse le seuil de concentration.',
  sell_simulation: 'Un devis de vente existe, sans taxe ni impact prix anormal (simulation, aucune transaction).',
  metadata_mutable: 'Les métadonnées sont figées : le nom et le symbole ne peuvent plus changer.',
  token_age: "Le token et son pool ont un peu d'historique.",
  creator_history: "Aucun token mort ou victime d'un rug n'a été trouvé dans l'historique du créateur.",
  rugcheck: "RugCheck ne signale pas de risque particulier.",
};

/** Phrase simple d'un contrôle : raison principale (critique d'abord), ou phrase « ok ». */
export function summarizeCheck(outcome: RiskCheckOutcome): string {
  const first = outcome.reasonCodes[0];
  return first === undefined ? OK_SENTENCES[outcome.id] : REASON_SENTENCES[first];
}

/** Libellés courts des contrôles non évalués (phrase « contrôle rapide »). */
const NOT_EVALUATED_LABELS: Readonly<Record<AnalysisCheckId, string>> = {
  mint_authority: 'autorité de mint',
  freeze_authority: 'autorité de freeze',
  liquidity: 'liquidité',
  holder_concentration: 'concentration',
  sell_simulation: 'revente (honeypot)',
  metadata_mutable: 'métadonnées',
  token_age: 'âge',
  creator_history: 'créateur',
  rugcheck: 'RugCheck',
};

/** Longueur maximale d'une explication (contrat `walletTokenAssessmentSchema.explanation`, analyse). */
export const EXPLANATION_MAX_LENGTH = 280;

export interface ExplainOptions {
  /**
   * Contrôles non demandés par le profil (règle D3, `LIGHT_PROFILE_NOT_EVALUATED` pour le scan de
   * wallet) : ils ne sont pas annoncés « indisponibles » et la phrase précise « contrôle rapide ».
   */
  readonly notEvaluated?: readonly AnalysisCheckId[];
}

function listFr(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1] as string}`;
}

/**
 * Phrase d'explication du verdict (280 caractères max). Le rappel « aucun signal détecté ne veut
 * pas dire sans risque » (`SAFE_VERDICT_REMINDER`) et la mention « pas un conseil en
 * investissement » sont affichés à part par l'interface. Avec `notEvaluated` (règle D3), la phrase
 * se termine par « Contrôle rapide (6/9) : … non évalués. » : un Sain rapide ne dit rien du honeypot.
 */
export function explainVerdict(assessment: RiskAssessment, options: ExplainOptions = {}): string {
  const skipped = new Set(options.notEvaluated ?? []);
  const missing = assessment.checks.filter((check) => check.status === 'unavailable');
  const notEvaluated = missing.filter((check) => skipped.has(check.id));
  const unavailable = missing.length - notEvaluated.length;
  const unavailableNote =
    unavailable > 0 ? ` ${unavailable} contrôle${unavailable > 1 ? 's' : ''} indisponible${unavailable > 1 ? 's' : ''}.` : '';
  const lightNote =
    skipped.size === 0
      ? ''
      : notEvaluated.length === 0
        ? ` Contrôle rapide (${assessment.checks.length - missing.length}/${assessment.checks.length}).`
        : ` Contrôle rapide (${assessment.checks.length - missing.length}/${assessment.checks.length}) : ${listFr(
            notEvaluated.map((check) => NOT_EVALUATED_LABELS[check.id]),
          )} non évalués.`;

  let sentence: string;
  if (assessment.verdict === 'danger') {
    const critical = assessment.reasons.find((reason) => reason.critical);
    sentence = `Signal critique détecté. ${critical ? REASON_SENTENCES[critical.code] : ''}`.trim();
  } else if (assessment.verdict === 'warn') {
    const warnings = assessment.checks.filter((check) => check.status === 'warn').length;
    sentence =
      warnings === 0
        ? `Trop de contrôles n'ont pas pu être vérifiés pour conclure.${unavailableNote}`
        : `${warnings} contrôle${warnings > 1 ? 's' : ''} demande${warnings > 1 ? 'nt' : ''} ton attention, sans signal critique.${unavailableNote}`;
  } else {
    sentence = `Aucun signal critique ni modéré sur les contrôles disponibles.${unavailableNote}`;
  }
  const full = `${sentence}${lightNote}`;
  // Garde-fou du contrat : la phrase du verdict d'abord, la note « contrôle rapide » coupée au besoin.
  return full.length <= EXPLANATION_MAX_LENGTH ? full : `${full.slice(0, EXPLANATION_MAX_LENGTH - 1).trimEnd()}…`;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ageMetric(key: string, label: string, observedAt: string, date: string | null): CheckMetric {
  if (date === null) return { key, label, value: null, unit: 'days' };
  const hours = Math.max(0, (Date.parse(observedAt) - Date.parse(date)) / 3_600_000);
  return hours < 48
    ? { key, label, value: round(hours, 1), unit: 'hours' }
    : { key, label, value: round(hours / 24, 1), unit: 'days' };
}

/**
 * Valeurs chiffrées d'un contrôle (affichées par le front avec les formateurs de
 * `@raijin/shared-util`). Libellés rédigés par Raijin ; seules des valeurs numériques, booléennes
 * ou des adresses validées par le contrat y figurent.
 */
export function buildCheckMetrics(checkId: AnalysisCheckId, facts: RiskFacts): CheckMetric[] {
  const account = facts.mintAccount;
  switch (checkId) {
    case 'mint_authority':
      return account ? [{ key: 'mint_authority_active', label: 'Autorité de mint active', value: account.mintAuthorityActive, unit: null }] : [];
    case 'freeze_authority':
      return account
        ? [
            { key: 'freeze_authority_active', label: 'Autorité de freeze active', value: account.freezeAuthorityActive, unit: null },
            { key: 'permanent_delegate', label: 'Délégué permanent', value: account.extensions.permanentDelegate, unit: null },
          ]
        : [];
    case 'liquidity': {
      const liquidity = facts.liquidity;
      if (!liquidity) return [];
      return [
        { key: 'liquidity_usd', label: 'Liquidité (médiane)', value: liquidity.usd === null ? null : round(liquidity.usd, 0), unit: 'usd' },
        {
          key: 'lp_burned_or_locked',
          label: 'LP brûlée ou verrouillée',
          value: liquidity.lpBurnedOrLockedPct === null ? null : round(liquidity.lpBurnedOrLockedPct, 1),
          unit: 'percent',
        },
        { key: 'liquidity_samples', label: 'Sources de liquidité', value: liquidity.samples.length, unit: 'count' },
      ];
    }
    case 'holder_concentration': {
      const holders = facts.holders;
      if (!holders) return [];
      return [
        { key: 'top10_pct', label: 'Part du top 10', value: round(holders.top10Pct, 1), unit: 'percent' },
        { key: 'max_holder_pct', label: 'Plus gros wallet', value: round(holders.maxSingleHolderPct, 1), unit: 'percent' },
        { key: 'excluded_accounts', label: 'Comptes exclus (LP, programmes)', value: holders.excludedAccounts, unit: 'count' },
      ];
    }
    case 'sell_simulation': {
      const sell = facts.sellSimulation;
      const metrics: CheckMetric[] = [];
      if (sell) {
        metrics.push(
          { key: 'route_found', label: 'Route de vente trouvée', value: sell.routeFound, unit: null },
          { key: 'test_amount_usd', label: 'Montant simulé', value: round(sell.testAmountUsd, 2), unit: 'usd' },
          { key: 'price_impact_pct', label: 'Impact prix', value: sell.priceImpactPct === null ? null : round(sell.priceImpactPct, 2), unit: 'percent' },
          { key: 'implicit_tax_pct', label: 'Taxe implicite', value: sell.implicitTaxPct === null ? null : round(sell.implicitTaxPct, 2), unit: 'percent' },
        );
      }
      if (account && account.extensions.transferFeeBps !== null) {
        metrics.push({ key: 'transfer_fee_pct', label: 'Frais de transfert', value: account.extensions.transferFeeBps / 100, unit: 'percent' });
      }
      return metrics;
    }
    case 'metadata_mutable':
      return facts.metadata ? [{ key: 'metadata_mutable', label: 'Métadonnées modifiables', value: facts.metadata.mutable, unit: null }] : [];
    case 'token_age':
      return facts.age
        ? [
            ageMetric('token_age', 'Âge du token', facts.observedAt, facts.age.tokenCreatedAt),
            ageMetric('pool_age', 'Âge du pool', facts.observedAt, facts.age.poolCreatedAt),
          ]
        : [];
    case 'creator_history': {
      const creator = facts.creator;
      if (!creator) return [];
      return [
        { key: 'creator_address', label: 'Créateur', value: creator.address, unit: 'address' },
        { key: 'tokens_launched', label: 'Autres tokens lancés', value: creator.tokensLaunched, unit: 'count' },
        { key: 'tokens_dead_or_rugged', label: 'Morts ou rug', value: creator.tokensDeadOrRugged, unit: 'count' },
      ];
    }
    case 'rugcheck': {
      const rugcheck = facts.rugcheck;
      if (!rugcheck) return [];
      return [
        { key: 'rugcheck_score', label: 'Score RugCheck (0 = sûr)', value: rugcheck.scoreNormalised, unit: null },
        { key: 'rugcheck_risks', label: 'Risques signalés', value: rugcheck.risks.length, unit: 'count' },
      ];
    }
  }
}
