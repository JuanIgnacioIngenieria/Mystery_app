import type { ApiErrorCode } from '@mystery/shared';

/**
 * Error de dominio listo para serializarse en HTTP. Los servicios lo lanzan
 * y el middleware de errores lo convierte en { error: { code, message } }
 * sin filtrar stack traces al cliente.
 */
export class ApiHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export function httpError(status: number, code: ApiErrorCode, message: string): ApiHttpError {
  return new ApiHttpError(status, code, message);
}
