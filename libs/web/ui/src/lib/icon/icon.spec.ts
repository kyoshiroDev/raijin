import { TestBed } from '@angular/core/testing';
import { RjIcon } from './icon';
import { RjIcons } from './icons';

describe('RjIcon', () => {
  it('rend une icône Lucide au trait de 1,75 en currentColor, décorative', async () => {
    const fixture = TestBed.createComponent(RjIcon);
    fixture.componentRef.setInput('name', 'safe');
    fixture.componentRef.setInput('size', 24);
    await fixture.whenStable();
    const svg = (fixture.nativeElement as HTMLElement).querySelector('svg') as SVGElement;
    expect(svg.getAttribute('stroke-width')).toBe('1.75');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('path')).toHaveLength(RjIcons.safe.length);
  });
});
