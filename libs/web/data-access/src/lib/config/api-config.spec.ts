import { TestBed } from '@angular/core/testing';
import { API_BASE_URL } from './api-config';

describe('API_BASE_URL', () => {
  it('vaut /api/v1 par défaut', () => {
    expect(TestBed.inject(API_BASE_URL)).toBe('/api/v1');
  });

  it('peut être surchargé par l’app', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: API_BASE_URL, useValue: 'http://localhost:3000/api/v1' }],
    });
    expect(TestBed.inject(API_BASE_URL)).toBe('http://localhost:3000/api/v1');
  });
});
