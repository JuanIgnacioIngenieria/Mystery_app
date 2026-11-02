import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import {
  createGameSchema,
  joinGameSchema,
  type CreateGameInput,
  type GameSessionPayload,
  type GameStatePayload,
  type JoinGameInput,
} from '@mystery/shared';
import { Router } from 'express';
import { isFirebaseConfigured } from '../config/env.js';
import { requirePlayerAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { createGame, getGameState, joinGameByCode } from '../services/games.service.js';
import { httpError } from '../utils/errors.js';

/**
 * Límites conservadores: crear/unirse son las operaciones sensibles
 * (crean documentos y pueden usarse para sondear códigos).
 */
const WRITE_LIMITER = createRateLimiter({ windowMs: 60_000, max: 20 });

/**
 * Valida el body con un schema zod y guarda el resultado tipado en
 * res.locals.input. Única puerta de entrada: ningún handler confía
 * en lo que envía el cliente.
 */
function parseBody<T>(schema: ZodType<T>): RequestHandler {
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

const readInput = (res: unknown): CreateGameInput | JoinGameInput => {
  // narrow con as aquí es aceptable: parseBody ya garantizó la forma.
  return (res as { locals: { input: CreateGameInput | JoinGameInput } }).locals.input;
};

const wrap = (status: number, run: (input: unknown) => Promise<unknown>): RequestHandler => {
  return async (req, res, next) => {
    try {
      res.status(status).json(await run(readInput(res)));
    } catch (error) {
      next(error);
    }
  };
};

export const gamesRouter = Router();

/**
 * Estado del backend, útil al configurar el proyecto: responde 200
 * aunque falten credenciales, para diagnóstico del setup.
 */
gamesRouter.get('/health', (_req, res) => {
  res.json({ ok: true, database: isFirebaseConfigured() ? 'firebase' : 'not_configured' });
});

gamesRouter.post(
  '/',
  WRITE_LIMITER,
  parseBody(createGameSchema),
  wrap(201, (input) => createGame(input as CreateGameInput)),
);

gamesRouter.post(
  '/join',
  WRITE_LIMITER,
  parseBody(joinGameSchema),
  wrap(200, (input) => joinGameByCode(input as JoinGameInput)),
);

/**
 * Lobby autenticado: requiere token de credencial, no solo el código.
 * Es el patrón que usarán pistas, notas y votaciones más adelante.
 */
gamesRouter.get('/:gameId/state', requirePlayerAuth, async (req, res, next) => {
  try {
    // Igual que en auth: los params de Express 5 pueden tipar como array.
    const rawGameId = req.params.gameId ?? '';
    const gameId = Array.isArray(rawGameId) ? (rawGameId[0] ?? '') : rawGameId;
    if (gameId.length === 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'Falta el identificador de la partida.');
    }
    const token = (req.headers.authorization ?? '').split(' ')[1]!.trim().toLowerCase();
    const state: GameStatePayload = await getGameState(gameId, token);
    res.json(state);
  } catch (error) {
    next(error);
  }
});

// Export del tipo de payload para reutilizarlo en la app sin duplicarlo.
export type { GameSessionPayload };
