import { describe, expect, it } from 'vitest';
import {
  articleLd,
  breadcrumbLd,
  canonicalPath,
  canonicalUrl,
  faqPageLd,
  ogImageUrl,
  organizationLd,
  serializeJsonLd,
  softwareApplicationLd,
} from './seo';

describe('canonicalUrl', () => {
  it.each([
    ['/', 'https://raijinshield.com/'],
    ['/index.html', 'https://raijinshield.com/'],
    ['/index', 'https://raijinshield.com/'],
    ['', 'https://raijinshield.com/'],
    ['/tarifs', 'https://raijinshield.com/tarifs'],
    ['/tarifs.html', 'https://raijinshield.com/tarifs'],
    ['/tarifs/', 'https://raijinshield.com/tarifs'],
    ['/guides/index.html', 'https://raijinshield.com/guides'],
    ['/guides/mint-authority.html', 'https://raijinshield.com/guides/mint-authority'],
    ['/faq?utm_source=x#q', 'https://raijinshield.com/faq'],
    ['//faq', 'https://raijinshield.com/faq'],
    ['faq', 'https://raijinshield.com/faq'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalUrl(input)).toBe(expected);
  });

  it('ne garde jamais .html, /index ni barre finale', () => {
    for (const path of ['/a.html', '/a/index.html', '/a/b/', '/a/index']) {
      expect(canonicalPath(path)).not.toMatch(/\.html$|\/index$|.\/$/);
    }
  });

  it('construit les URL des images OG', () => {
    expect(ogImageUrl('tarifs')).toBe('https://raijinshield.com/og/tarifs.png');
  });
});

describe('serializeJsonLd', () => {
  it('échappe tout ce qui pourrait fermer la balise script', () => {
    const json = serializeJsonLd({ name: '</script><script>alert(1)</script> & \u2028' });
    expect(json).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(json)).toEqual({ name: '</script><script>alert(1)</script> & \u2028' });
  });
});

describe('données structurées', () => {
  it('Organization et SoftwareApplication portent le nom officiel', () => {
    expect(organizationLd()).toMatchObject({ '@type': 'Organization', name: 'Raijin Shield' });
    const app = softwareApplicationLd('desc', [{ name: 'Pro', priceCents: 1490, currency: 'EUR' }]);
    expect(app).toMatchObject({ '@type': 'SoftwareApplication', name: 'Raijin Shield' });
    expect(app['offers']).toEqual([expect.objectContaining({ '@type': 'Offer', price: '14.90', priceCurrency: 'EUR' })]);
  });

  it('FAQPage, BreadcrumbList et Article', () => {
    const faq = faqPageLd([{ id: 'a', question: 'Q ?', answer: 'R.' }]);
    expect(faq['mainEntity']).toEqual([
      { '@type': 'Question', name: 'Q ?', acceptedAnswer: { '@type': 'Answer', text: 'R.' } },
    ]);
    const crumbs = breadcrumbLd([
      { name: 'Accueil', path: '/' },
      { name: 'Guides', path: '/guides.html' },
    ]);
    expect(crumbs['itemListElement']).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Accueil', item: 'https://raijinshield.com/' },
      { '@type': 'ListItem', position: 2, name: 'Guides', item: 'https://raijinshield.com/guides' },
    ]);
    const article = articleLd({
      title: 'T',
      description: 'D',
      path: '/guides/x',
      image: ogImageUrl('guide-x'),
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    expect(article).toMatchObject({
      '@type': 'Article',
      headline: 'T',
      mainEntityOfPage: 'https://raijinshield.com/guides/x',
      dateModified: '2026-01-02T00:00:00.000Z',
    });
  });
});
