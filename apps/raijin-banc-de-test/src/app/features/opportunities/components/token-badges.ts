import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input } from '@angular/core';
import { type TokenRow, formatAge } from '@raijin/bench-web-logic';
import { Icon } from '../../../shared/ui/icon';
import { MOMENTUM_HINT, MOMENTUM_LABEL, momentumOf, safetyCheck, safetyDescription } from '@raijin/bench-web-logic/opportunities';

let nextId = 0;

/**
 * Factual badges of a token (card + detail): age, « Calme » / « Frénésie » (nothing when neither), « Sécurité OK » /
 * « Sécurité KO ». Every badge is text (never colour only); the failed safety rules are given as screen-reader text on
 * the card and as a visible list in the detail (`detailed`). Rules: token-signals.ts. Not a buy signal.
 */
@Component({
  selector: 'app-token-badges',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    @let s = safety();
    <ul class="flex flex-wrap items-center gap-1.5" aria-label="Signaux factuels" data-badges>
      <li class="pill gap-1 bg-surface-2 text-fg tabular-nums slashed-zero" data-badge="age">
        <app-icon name="clock" class="size-3 text-muted" />
        Âge {{ age() }}
      </li>
      @if (momentum(); as m) {
        <li class="pill" [class]="m === 'calm' ? 'bg-info/15 text-info' : 'bg-warn/15 text-warn'" [attr.data-badge]="m" [attr.title]="hint[m]">
          {{ label[m] }}<span class="sr-only"> : {{ hint[m] }}</span>
        </li>
      }
      <li
        class="pill gap-1"
        [class]="s.ok ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-fg ring-1 ring-inset ring-bear/50'"
        [attr.data-badge]="s.ok ? 'safety-ok' : 'safety-ko'"
        [attr.aria-describedby]="detailed() && !s.ok ? uid : null"
      >
        <!-- KO : texte fg (texte bear sur teinte bear/15 < 4,5:1 sur les surfaces), sémantique portée par l'icône et le liseré bear. -->
        <app-icon [name]="s.ok ? 'check' : 'alert'" class="size-3" [class.text-bear]="!s.ok" />
        {{ s.ok ? 'Sécurité OK' : 'Sécurité KO' }}
        @if (!detailed()) {
          <span class="sr-only">. {{ description() }}</span>
        }
      </li>
    </ul>
    @if (detailed() && !s.ok) {
      <ul [id]="uid" class="mt-2 list-disc space-y-0.5 pl-5 text-xs text-bear" aria-label="Règles de sécurité non remplies" data-safety-failures>
        @for (f of s.failures; track f) {
          <li>{{ f }}</li>
        }
      </ul>
    }
  `,
})
export class TokenBadges {
  readonly token = input.required<TokenRow>();
  /** Detail view: the failed safety rules are listed visibly under the badges. */
  readonly detailed = input(false, { transform: booleanAttribute });

  protected readonly uid = `token-badges-${++nextId}`;
  protected readonly label = MOMENTUM_LABEL;
  protected readonly hint = MOMENTUM_HINT;
  protected readonly age = computed(() => formatAge(this.token().pair_created_at));
  protected readonly momentum = computed(() => momentumOf(this.token(), Date.now()));
  protected readonly safety = computed(() => safetyCheck(this.token()));
  protected readonly description = computed(() => safetyDescription(this.safety()));
}
