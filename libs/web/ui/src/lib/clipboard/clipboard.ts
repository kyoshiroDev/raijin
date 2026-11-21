import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

/**
 * Accès au presse-papiers : Clipboard API d'abord, repli `execCommand('copy')` pour la copie.
 * La lecture n'a pas de repli possible : elle renvoie `null` si l'API est absente ou refusée,
 * et l'appelant propose alors le collage manuel (appui long dans le champ).
 */
@Injectable({ providedIn: 'root' })
export class RjClipboard {
  private readonly document = inject(DOCUMENT);

  async copy(text: string): Promise<boolean> {
    const clipboard = this.document.defaultView?.navigator.clipboard;
    if (clipboard?.writeText) {
      try {
        await clipboard.writeText(text);
        return true;
      } catch {
        // Refus ou contexte non sécurisé : on tente le repli.
      }
    }
    return this.legacyCopy(text);
  }

  async read(): Promise<string | null> {
    const clipboard = this.document.defaultView?.navigator.clipboard;
    if (!clipboard?.readText) {
      return null;
    }
    try {
      return await clipboard.readText();
    } catch {
      return null;
    }
  }

  private legacyCopy(text: string): boolean {
    const doc = this.document;
    if (typeof doc.execCommand !== 'function') {
      return false;
    }
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.select();
    try {
      return doc.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}
