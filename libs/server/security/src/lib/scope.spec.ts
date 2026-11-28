import { SERVER_SECURITY_SCOPE } from '../index';

describe('server-security', () => {
  it('expose son identifiant de lib', () => {
    expect(SERVER_SECURITY_SCOPE).toBe('server-security');
  });
});
