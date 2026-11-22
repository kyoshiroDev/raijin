import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { type SignupAttribution } from '@raijin/shared-contracts';
import { loadContracts } from '../contracts';

/** Clé de session (attribution marketing uniquement, aucune donnée d'auth). */
export const ATTRIBUTION_KEY = 'rj.attribution';

/** Bornes appliquées dès la capture (le schéma revalide tout à la lecture). */
const MAX_LABEL = 200;
const MAX_URL = 2048;

/**
 * Attribution de première visite (UTM, provenance, page d'arrivée), envoyée à l'inscription.
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
    if (this.readRaw() !== null) return Promise.resolve();
    const location = this.document.location;
    const params = new URLSearchParams(location.search);
    const candidate: Record<string, string> = {};
    const add = (key: keyof SignupAttribution, value: string | null | undefined, max: number) => {
      if (value) candidate[key] = value.slice(0, max + 1);
    };
    add('utmSource', params.get('utm_source'), MAX_LABEL);
    add('utmMedium', params.get('utm_medium'), MAX_LABEL);
    add('utmCampaign', params.get('utm_campaign'), MAX_LABEL);
    add('referrer', this.externalReferrer(), MAX_URL);
    add('landingPath', location.pathname, 512);
    if (!candidate['utmSource'] && !candidate['utmMedium'] && !candidate['utmCampaign'] && !candidate['referrer']) {
      return Promise.resolve();
    }
    return loadContracts().then(({ signupAttributionSchema }) => {
      // Champ par champ : une valeur invalide est ignorée sans perdre les autres.
      const clean: SignupAttribution = {};
      for (const [key, value] of Object.entries(candidate)) {
        const parsed = signupAttributionSchema.safeParse({ [key]: value });
        if (parsed.success) Object.assign(clean, parsed.data);
      }
      if (clean.utmSource || clean.utmMedium || clean.utmCampaign || clean.referrer) this.write(clean);
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
