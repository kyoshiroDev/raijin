import { ChangeDetectionStrategy, Component } from '@angular/core';
import { BoltMark } from './bolt-mark';

/** Wordmark « RAIJIN » + lightning (the logo is one of the few places the accent is allowed). Place it inside the h1. */
@Component({
  selector: 'app-brand',
  imports: [BoltMark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex items-center gap-1' },
  template: `<span>RAI<span class="text-accent">JIN</span></span><app-bolt-mark class="size-[0.9em]" tone="brand" />`,
})
export class Brand {}
