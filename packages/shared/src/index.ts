import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constantes del dominio. Único punto de verdad para la app y el backend:
// si mañana cambia el tamaño de los códigos o el límite de jugadores,
// ambas partes quedan sincronizadas sin tocar dos repositorios.
// ---------------------------------------------------------------------------

/** Longitud del código de invitación (sin caracteres ambiguos). */
export const GAME_CODE_LENGTH = 5;

/** Máximo de jugadores por partida (el anfitrión cuenta como primero). */
export const MAX_PLAYERS = 10;

/** Longitud del token de acceso privado (en bytes, antes de hex-encode). */
export const ACCESS_TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// Validación de entradas. Las mismas reglas se aplican en la app (feedback
// inmediato al usuario) y en el backend (fuente de verdad: nunca se confía
// en lo que envía el cliente).
// ---------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const gameCodeSchema = z
  .string()
  .transform((v) => v.trim().toUpperCase().replace(/[\s-]/g, '')) //Transforma el codigo, elimina espacios con trim, convierte letras a mayusculas y elimina espacios o guiones
  .pipe( //Valida el resultado de la transformación, si no cumple con las reglas, devuelve un error 
    z.string()
      .length(GAME_CODE_LENGTH, `El código debe tener ${GAME_CODE_LENGTH} caracteres`)
      .regex( //Comprueba que la expresion regular contiene los caracteres permitidos, si no devuelve un error
        new RegExp(`^[${CODE_ALPHABET}]+$`),
        'El código solo admite letras y números (sin O, I, 0 ni 1)',
      ),
  );

export const displayNameSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ' ').trim())
  .pipe(
    z.string()
      .min(2, 'El nombre debe tener al menos 2 caracteres')
      .max(20, 'El nombre no puede superar los 20 caracteres'),
  );

/**
 * Identidad estable del dispositivo: la genera la app, vive en SecureStore y
 * viaja en cada create/join. El backend la HASEA y la usa como clave de la
 * sesión activa; así se garantiza (no solo en la UI) que cada dispositivo
 * solo pertenezca a una partida a la vez, incluso con peticiones concurrentes.
 */
export const deviceIdSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(
    z
      .string()
      .min(8, 'Identificador de dispositivo inválido')
      .max(64, 'Identificador de dispositivo inválido')
      .regex(/^[A-Za-z0-9-]+$/, 'Identificador de dispositivo inválido'),
  );

export const createGameSchema = z.object({
  displayName: displayNameSchema,
  deviceId: deviceIdSchema,
});

export const joinGameSchema = z.object({
  code: gameCodeSchema,
  displayName: displayNameSchema,
  deviceId: deviceIdSchema,
});

// ---------------------------------------------------------------------------
// Contratos de la API. Tipos derivados de los schemas para que un documento
// de Firestore y una respuesta HTTP nunca se desalineen.
// ---------------------------------------------------------------------------

export type GameCode = z.infer<typeof gameCodeSchema>;
export type DisplayedName = z.infer<typeof displayNameSchema>;
export type CreateGameInput = z.infer<typeof createGameSchema>;
export type JoinGameInput = z.infer<typeof joinGameSchema>;
/** Estado del ciclo de vida de la partida (se ampliará en próximas iteraciones). */
export type GameStatus = 'open' | 'in_progress' | 'closed';

/** Vista pública de un jugador: nunca incluye el hash del token ni datos privados. */
export interface PlayerView {
  id: string;
  displayName: string;
  isHost: boolean;
}

/** Vista pública de una partida: el código es lo único que se comparte por chat. */
export interface GameView {
  id: string;
  code: string;
  status: GameStatus;
  hostPlayerId: string;
  maxPlayers: number;
  playerCount: number;
}

/** Respuesta al crear o unirse: contiene el token privado, que viaja una única vez. */
export interface GameSessionPayload {
  game: GameView;
  player: PlayerView;
  /** Credencial privada de 64 caracteres hex. Guardar en almacenamiento seguro. */
  token: string;
}

/** Lista de jugadores de la partida, obtenida con credencial privada. */
export interface GameStatePayload {
  game: GameView;
  players: PlayerView[];
}

// ---------------------------------------------------------------------------
// Códigos de error estables. La app los usa para mostrar el mensaje correcto
// sin depender de textos HTTP; el backend los emite siempre en el mismo campo.
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'GAME_NOT_FOUND'
  | 'GAME_CLOSED'
  | 'GAME_FULL'
  | 'GAME_NOT_HOST'
  | 'GAME_IN_PROGRESS'
  | 'ALREADY_IN_GAME'
  | 'AUTH_MISSING'
  | 'AUTH_INVALID'
  | 'RATE_LIMITED'
  | 'BACKEND_NOT_CONFIGURED'
  | 'INTERNAL_ERROR'
  | 'NOT_FOUND'
  | 'NETWORK_ERROR';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Utilidades. Normalizar el código en "shared" evita que "AB-CD1" funcione en
// la app y falle en el backend (o al revés).
// ---------------------------------------------------------------------------

/**
 * Normaliza lo que el usuario teclea antes de validar: mayúsculas, sin
 * espacios ni guiones. Devuelve también si tiene el formato básico correcto,
 * para deshabilitar botones sin mostrar errores agresivos mientras escribe.
 */
export function normalizeGameCode(raw: string): { value: string; looksValid: boolean } { //Recibe el texto en raw, lo transforma a mayusculas y elimina espacios o guiones, luego valida si cumple con las reglas de longitud y caracteres permitidos

  const value = raw.toUpperCase().replace(/[\s-]/g, '');
  const looksValid = new RegExp(`^[${CODE_ALPHABET}]{${GAME_CODE_LENGTH}}$`).test(value);
  return { value, looksValid };
}

/** Alfabeto expuesto para tests y generadores; mantenlo sin 0, O, 1, I, L. */
export const CODE_ALPHABET_SET = CODE_ALPHABET;
