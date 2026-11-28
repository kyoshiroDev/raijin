import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { type SignupAttribution } from '@raijin/shared-contracts';
import { loadContracts } from '../contracts';

/** Clé de session (attribution marketing uniquement, aucune donnée d'auth). */
export const ATTRIBUTION_KEY = 'rj.attribution';

/** Bornes appliquées dès la capture (le schéma revalide tout à la lecture). */
const MAX_LABEL = 200;
const MAX_URL = 2048;
const MAX_PATH = 512;

/**
 * Paramètres posés par la landing sur ses liens vers l'app (miroir de `ATTRIBUTION_QUERY_PARAMS`, contrat
 * `analytics/ga4.ts`, vérifié par un test) : recopiés ici pour ne pas charger les contrats au démarrage.
 * `rj_ref` = référent de la première visite sur la landing, `rj_lp` = page d'arrivée sur la landing.
 */
export const ATTRIBUTION_PARAMS = {
  utmSource: 'utm_source',
  utmMedium: 'utm_medium',
  utmCampaign: 'utm_campaign',
  referrer: 'rj_ref',
  landingPath: 'rj_lp',
} as const;

/**
 * Attribution de première visite (UTM, provenance, page d'arrivée), envoyée à l'inscription.
 * Depuis la landing, `rj_ref` et `rj_lp` remplacent `document.referrer` et le chemin courant ; chaque valeur
 * reste validée (une valeur hostile ou trop longue est ignorée sans perdre les autres).
 * Lue dans l'URL au premier chargement et gardée pour la durée de l'onglet (`sessionStorage`) :
 * premier contact retenu. Les valeurs sont validées par `signupAttributionSchema` (contrats,
 * chargés à la demande) avant d'être écrites et à chaque lecture.
 */
@Injectable({ providedIn: 'root' })
export class AttributionTracker {
  private readonly document = inject(DOCUMENT);

  /**
   * À appeler une fois au démarrage : relevé synchrone de l'URL (avant toute navigation),
   * validation puis écriture ensuite. Ne remplace jamais une attribution déjà retenue.
   */
  capture(): Promise<void> {
    return this.commit(this.snapshot());
  }

  /**
   * Relevé **synchrone** de l'URL d'arrivée (UTM, provenance, page), sans validation ni contrats :
   * appelé au démarrage, avant que la navigation initiale ne réécrive l'URL. `null` si rien à
   * retenir (aucun signal, ou attribution déjà retenue).
   */
  snapshot(): Record<string, string> | null {
    if (this.readRaw() !== null) return null;
    const location = this.document.location;
    const params = new URLSearchParams(location.search);
    const candidate: Record<string, string> = {};
    const add = (key: keyof SignupAttribution, value: string | null | undefined, max: number) => {
      if (value) candidate[key] = value.slice(0, max + 1);
    };
    const param = (key: keyof typeof ATTRIBUTION_PARAMS) => params.get(ATTRIBUTION_PARAMS[key]);
    add('utmSource', param('utmSource'), MAX_LABEL);
    add('utmMedium', param('utmMedium'), MAX_LABEL);
    add('utmCampaign', param('utmCampaign'), MAX_LABEL);
    // Venue de la landing : son référent et sa page d'arrivée priment (sinon le référent serait la landing).
    add('referrer', param('referrer') || this.externalReferrer(), MAX_URL);
    const fromLanding = param('landingPath');
    if (!candidate['utmSource'] && !candidate['utmMedium'] && !candidate['utmCampaign'] && !candidate['referrer'] && !fromLanding) {
      return null;
    }
    add('landingPath', fromLanding || location.pathname, MAX_PATH);
    return candidate;
  }

  /** Valide (contrats chargés à la demande) puis retient un relevé de `snapshot()`. */
  commit(candidate: Record<string, string> | null): Promise<void> {
    if (candidate === null || this.readRaw() !== null) return Promise.resolve();
    return loadContracts().then(({ signupAttributionSchema }) => {
      // Champ par champ : une valeur invalide est ignorée sans perdre les autres.
      const clean: SignupAttribution = {};
      for (const [key, value] of Object.entries(candidate)) {
        const parsed = signupAttributionSchema.safeParse({ [key]: value });
        if (parsed.success) Object.assign(clean, parsed.data);
      }
      if (Object.keys(clean).length > 0) this.write(clean);
    });
  }

  /** Attribution retenue (revalidée), ou `undefined`. */
  async read(): Promise<SignupAttribution | undefined> {
    const raw = this.readRaw();
    if (raw === null) return undefined;
    try {
      const { signupAttributionSchema } = await loadContracts();
      const parsed = signupAttributionSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private readRaw(): string | null {
    try {
      return this.document.defaultView?.sessionStorage.getItem(ATTRIBUTION_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private write(value: SignupAttribution): void {
    try {
      this.document.defaultView?.sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(value));
    } catch {
      // Stockage indisponible (navigation privée stricte) : pas d'attribution, sans conséquence.
    }
  }

  private externalReferrer(): string | null {
    const referrer = this.document.referrer;
    if (!referrer) return null;
    try {
      return new URL(referrer).origin === this.document.location.origin ? null : referrer;
    } catch {
      return null;
    }
  }
}
