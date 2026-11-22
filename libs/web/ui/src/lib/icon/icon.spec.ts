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

  it('suit les changements de nom, de taille et de rotation sans dupliquer le SVG', async () => {
    const fixture = TestBed.createComponent(RjIcon);
    fixture.componentRef.setInput('name', 'safe');
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('svg')?.getAttribute('width')).toBe('20');
    fixture.componentRef.setInput('name', 'danger');
    fixture.componentRef.setInput('size', 16);
    fixture.componentRef.setInput('spin', true);
    await fixture.whenStable();
    expect(host.querySelectorAll('svg')).toHaveLength(1);
    const svg = host.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
    expect(svg.classList.contains('animate-spin')).toBe(true);
    expect(svg.children).toHaveLength(RjIcons.danger.length);
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });
});
