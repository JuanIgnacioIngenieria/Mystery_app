import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ACCESS_TOKEN_BYTES, CODE_ALPHABET_SET, GAME_CODE_LENGTH } from '@mystery/shared';

/**
 * Genera un código de invitación impredecible: usa un CSPRNG (randomInt) y
 * un alfabeto sin caracteres ambiguos (no hay 0/O/1/I/L), lo que reduce
 * errores humanos al compartir el código sin ampliar el espacio de búsqueda.
 */
export function generateGameCode(): string {
  let code = '';
  for (let i = 0; i < GAME_CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET_SET[randomInt(CODE_ALPHABET_SET.length)];
  }
  return code;
}

/**
 * Token privado del jugador (128 bits hex). Nace aleatorio por petición,
 * se entrega una sola vez y en Firestore solo guarda su hash SHA-256:
 * una fuga de la base de datos no expone credenciales utilizables.
 */
export function generateAccessToken(): string {
  return randomBytes(ACCESS_TOKEN_BYTES).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * El deviceId generado por la app tampoco se almacena en claro: guardamos solo
 * su hash como clave de la sesión activa. Un filtrado de la base de datos no
 * permite suplantar ni rastrear dispositivos.
 */
export function hashDeviceId(deviceId: string): string {
  return createHash('sha256').update(deviceId).digest('hex');
}

/** Formato canónico del token; evita consultas a Firestore con entradas basura. */
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
