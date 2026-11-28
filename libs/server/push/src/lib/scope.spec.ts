import { SERVER_PUSH_SCOPE } from '../index';

describe('server-push', () => {
  it('expose son identifiant de lib', () => {
    expect(SERVER_PUSH_SCOPE).toBe('server-push');
  });
});
