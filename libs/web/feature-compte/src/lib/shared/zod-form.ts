import { computed, signal, type Signal } from '@angular/core';
import { type z } from 'zod';

export type FieldErrors<T> = Partial<Record<keyof T & string, string>>;

/** Formulaire en signals validé par un schéma Zod des contrats (une seule source de règles). */
export interface ZodForm<T extends object, Out> {
  readonly value: Signal<T>;
  /** Erreurs visibles : champ quitté une fois, ou après une tentative d'envoi. */
  readonly errors: Signal<FieldErrors<T>>;
  readonly valid: Signal<boolean>;
  set<K extends keyof T>(key: K, value: T[K]): void;
  touch(key: keyof T & string): void;
  /** Marque le formulaire comme soumis ; renvoie les données validées (et normalisées) ou `null`. */
  submit(): Out | null;
  /** Erreur venue du serveur, rattachée à un champ (effacée à la prochaine saisie du champ). */
  setServerError(key: keyof T & string, message: string): void;
  reset(value?: T): void;
}

export function zodForm<T extends object, Out>(schema: z.ZodType<Out>, initial: T): ZodForm<T, Out> {
  const value = signal<T>(initial);
  const touched = signal<ReadonlySet<string>>(new Set());
  const submitted = signal(false);
  const server = signal<FieldErrors<T>>({});
  const result = computed(() => schema.safeParse(value()));

  const errors = computed<FieldErrors<T>>(() => {
    const out: Record<string, string> = { ...(server() as Record<string, string>) };
    const parsed = result();
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (!key || key in out) continue;
        if (submitted() || touched().has(key)) out[key] = issue.message;
      }
    }
    return out as FieldErrors<T>;
  });

  return {
    value: value.asReadonly(),
    errors,
    valid: computed(() => result().success),
    set(key, next) {
      value.update((current) => ({ ...current, [key]: next }));
      const name = key as keyof T & string;
      if (server()[name] !== undefined) {
        server.update((current) => {
          const copy = { ...current };
          delete copy[name];
          return copy;
        });
      }
    },
    touch(key) {
      // Un champ vide quitté sans saisie n'affiche pas encore d'erreur (pas de rouge au premier passage).
      const current = (value() as Record<string, unknown>)[key];
      if (current === '' || current === false) return;
      touched.update((set) => new Set(set).add(key));
    },
    submit() {
      submitted.set(true);
      const parsed = result();
      return parsed.success ? parsed.data : null;
    },
    setServerError(key, message) {
      server.update((current) => ({ ...current, [key]: message }));
    },
    reset(next = initial) {
      value.set(next);
      touched.set(new Set());
      submitted.set(false);
      server.set({});
    },
  };
}
