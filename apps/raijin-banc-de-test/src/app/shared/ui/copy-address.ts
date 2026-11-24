import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { addressHead, addressTail, isSolanaAddress, shortAddress } from '../utils/solana-address';
import { Icon } from './icon';

type CopyState = 'idle' | 'copied' | 'error';

/**
 * The ONLY way to copy a token address in Raijin.
 * - copies only a valid Solana address (base58, 32 bytes)
 * - shows the first/last 4 characters to check after pasting (address-poisoning protection)
 */
@Component({
  selector: 'app-copy-address',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block @container' },
  template: `
    <button
      type="button"
      class="btn-ghost w-full justify-between"
      [disabled]="!valid()"
      [title]="address()"
      [attr.aria-label]="ariaLabel()"
      (click)="copy()"
    >
      <span class="font-mono text-xs whitespace-nowrap text-muted">{{ short() }}</span>
      <span class="inline-flex items-center gap-1.5 whitespace-nowrap" [class.text-bull]="state() === 'copied'" [class.text-bear]="state() === 'error'">
        <!-- Icon only when the button is wide enough (container query): the label never wraps. -->
        <span class="hidden @[16rem]:contents" data-copy-icon>
          <app-icon [name]="state() === 'copied' ? 'check' : state() === 'error' ? 'alert' : 'copy'" class="size-4" />
        </span>
        {{ actionText() }}
      </span>
    </button>
    @if (!valid()) {
      <p class="mt-1 text-label text-bear">Adresse invalide : copie bloquée.</p>
    }
    @if (state() === 'copied') {
      <p class="mt-1 text-label text-muted" role="status">
        Après collage, vérifie : commence par <b class="font-mono text-fg">{{ head() }}</b>, finit par
        <b class="font-mono text-fg">{{ tail() }}</b>.
      </p>
    }
  `,
})
export class CopyAddress {
  readonly address = input.required<string>();
  readonly label = input('');

  readonly valid = computed(() => isSolanaAddress(this.address()));
  readonly short = computed(() => shortAddress(this.address()));
  readonly head = computed(() => addressHead(this.address()));
  readonly tail = computed(() => addressTail(this.address()));
  readonly state = signal<CopyState>('idle');
  readonly actionText = computed(() => ({ copied: 'Copié', error: 'Échec', idle: 'Copier l’adresse' })[this.state()]);
  /** WCAG 2.5.3 : le nom accessible commence par le texte visible (adresse courte puis action), le contexte vient après. */
  readonly ariaLabel = computed(() => {
    const visible = `${this.short()} ${this.actionText()}`;
    const ctx = this.label().trim();
    return ctx ? `${visible} du token ${ctx}` : visible;
  });

  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  async copy(): Promise<void> {
    const value = this.address();
    if (!isSolanaAddress(value)) {
      this.state.set('error');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      this.state.set('copied');
    } catch {
      this.state.set('error');
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.state.set('idle'), 8_000);
  }
}
