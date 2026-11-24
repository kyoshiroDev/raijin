// Error shaped like the app's `BenchApiError` (status, code, message): the lib reads errors by duck typing.
export class FakeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'BenchApiError';
  }
}

export function apiError(status: number, code: string | null = null, message = 'Erreur simulée.'): FakeApiError {
  return new FakeApiError(status, code, message);
}
