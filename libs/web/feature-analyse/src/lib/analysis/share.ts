import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { RjClipboard } from '@raijin/web-ui';

/** Issue d'un partage : feuille native, lien copié, annulé par l'utilisateur ou impossible. */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

export interface SharePayload {
  readonly title: string;
  readonly text: string;
  readonly url: string;
}

/** Lien public d'une analyse : `<origine>/t/<mint>`. */
export function publicTokenUrl(origin: string, mint: string): string {
  return `${origin.replace(/\/$/, '')}/t/${encodeURIComponent(mint)}`;
}

/**
 * Partage d'une analyse : Web Share API (feuille native du mobile) quand elle existe, sinon
 * copie du lien public dans le presse-papiers.
 */
@Injectable({ providedIn: 'root' })
export class AnalysisShare {
  private readonly document = inject(DOCUMENT);
  private readonly clipboard = inject(RjClipboard);

  /** Origine de l'app (pour construire le lien public). */
  origin(): string {
    return this.document.defaultView?.location.origin ?? '';
  }

  async share(payload: SharePayload): Promise<ShareOutcome> {
    const navigator = this.document.defaultView?.navigator;
    if (navigator && typeof navigator.share === 'function') {
      const data: ShareData = { title: payload.title, text: payload.text, url: payload.url };
      if (typeof navigator.canShare !== 'function' || navigator.canShare(data)) {
        try {
          await navigator.share(data);
          return 'shared';
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return 'cancelled';
          }
          // Partage refusé (permission, contexte) : on se rabat sur la copie du lien.
        }
      }
    }
    return (await this.clipboard.copy(payload.url)) ? 'copied' : 'failed';
  }
}
