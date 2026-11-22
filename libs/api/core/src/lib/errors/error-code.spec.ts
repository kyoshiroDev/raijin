import { errorCode } from './error-code';

describe('errorCode', () => {
  it('renvoie le code sûr, sinon le nom, jamais le message', () => {
    const withCode = Object.assign(new Error('connect ECONNREFUSED redis://user:secret@host:6379'), { code: 'ECONNREFUSED' });
    expect(errorCode(withCode)).toBe('ECONNREFUSED');
    expect(errorCode(Object.assign(new Error('x'), { code: 'P2002' }))).toBe('P2002');
    expect(errorCode(Object.assign(new Error('x'), { code: 42 }))).toBe('42');
    class PrismaClientInitializationError extends Error {
      override name = 'PrismaClientInitializationError';
    }
    expect(errorCode(new PrismaClientInitializationError('postgresql://u:p@db/raijin'))).toBe('PrismaClientInitializationError');
  });

  it('ignore les codes et noms suspects', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'a b <script>', name: 'nom avec espace' }))).toBe('UNKNOWN');
    expect(errorCode('chaîne')).toBe('UNKNOWN');
    expect(errorCode(null)).toBe('UNKNOWN');
  });
});
