import type { Request, RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { httpError } from './errors.js';

/**
 * Normaliza el param gameId (en Express 5 los params pueden tipar como
 * array): un solo punto de verdad para las rutas de /games/:gameId/*.
 */
export function gameIdParam(req: Request): string {
  const raw = req.params.gameId ?? '';
  return Array.isArray(raw) ? (raw[0] ?? '') : raw;
}

/**
 * Valida el body con un schema zod y guarda el resultado tipado en
 * res.locals.input. Única puerta de entrada: ningún handler confía
 * en lo que envía el cliente.
 */
export function parseBody<T>(schema: ZodType<T>): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issue = result.error.issues.at(0);
      next(httpError(400, 'VALIDATION_ERROR', issue?.message ?? 'Datos inválidos.'));
      return;
    }
    res.locals.input = result.data;
    next();
  };
}

/**
 * Helper de las rutas autenticadas sin body: la identidad del jugador SIEMPRE
 * viene de req.player (la fija requirePlayerAuth con el token) y el gameId
 * del path, nunca de lo que el cliente diga en ellos.
 */
export async function withPlayer(
  req: Request,
  run: (gameId: string, playerId: string) => Promise<unknown>,
): Promise<unknown> {
  const gameId = gameIdParam(req);
  const playerId = req.player?.playerId ?? '';
  if (gameId.length === 0 || playerId.length === 0) {
    throw httpError(401, 'AUTH_MISSING', 'Falta el token de acceso a la partida.');
  }
  return run(gameId, playerId);
}
