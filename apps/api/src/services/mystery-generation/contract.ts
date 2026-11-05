import type { MysteryContext } from '@mystery/shared';

// ---------------------------------------------------------------------------
// CONTRATO del proveedor de generación de misterios.
//
// Separa la lógica del juego de CUALQUIER proveedor concreto: hoy no existe
// integración real (no hay endpoint ni credenciales configuradas). Cuando se
// elija el modelo de IA bastará con implementar esta interfaz (o rellenar el
// .env para el RemoteMysteryProvider) — la partida, el contexto y la
// persistencia del resultado NO cambian.
// ---------------------------------------------------------------------------

/** Petición estándar al proveedor: el contexto completo del misterio. */
export interface MysteryGenerationRequest {
  context: MysteryContext;
}

/**
 * Clasificación interna de fallos del proveedor. Se registra en el documento
 * de la partida (lastGenerationError) para depuración futura sin filtrar
 * trazas técnicas al cliente.
 */
export type MysteryGenerationFailureCode =
  | 'GENERATION_NOT_CONFIGURED'
  | 'GENERATION_TIMEOUT'
  | 'GENERATION_UNREACHABLE'
  | 'GENERATION_HTTP_ERROR'
  | 'GENERATION_INVALID_RESPONSE'
  | 'GENERATION_CONTEXT_INCOMPLETE'
  | 'GENERATION_INTERNAL';

export class MysteryGenerationError extends Error {
  constructor(
    public readonly code: MysteryGenerationFailureCode,
    message: string,
    public readonly httpStatusHint?: number,
  ) {
    super(message);
    this.name = 'MysteryGenerationError';
  }
}

/**
 * El resultado es OPACO a propósito: todavía no existe proveedor ni formato
 * narrativo definido; se almacena tal cual (JSON válido) en Firestore para
 * que el contrato no invente estructura.
 */
export interface MysteryGenerationResult {
  provider: string;
  payload: unknown;
  generatedAt: Date;
}

export interface MysteryGenerationProvider {
  /** Nombre estable del proveedor (se persiste junto al resultado). */
  readonly name: string;
  generate(request: MysteryGenerationRequest): Promise<unknown>;
}
