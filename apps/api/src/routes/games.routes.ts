import type { Request, RequestHandler } from 'express';
import {
  createGameSchema,
  joinGameSchema,
  updatePlayerProfileSchema,
  type CreateGameInput,
  type GameSessionPayload,
  type GameStatePayload,
  type JoinGameInput,
  type UpdatePlayerProfileInput,
} from '@mystery/shared';
import { Router } from 'express';
import { isFirebaseConfigured } from '../config/env.js';
import { requirePlayerAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { createGame, getGameState, joinGameByCode, leaveGame, startGame, updatePlayerProfile } from '../services/games.service.js';
import { getMysteryForPlayer } from '../services/mystery.service.js';
import { httpError } from '../utils/errors.js';
import { gameIdParam, parseBody, withPlayer } from '../utils/request-helpers.js';

/**
 * Límites conservadores: crear/unirse son las operaciones sensibles
 * (crean documentos y pueden usarse para sondear códigos).
 */
const WRITE_LIMITER = createRateLimiter({ windowMs: 60_000, max: 20 });

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
    const gameId = gameIdParam(req);
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

/**
 * Vista del misterio PARA EL JUGADOR que llama (requiere partida 'ready').
 * El servicio filtra el payload: solo su personaje privado + info pública
 * compartida; nunca solution/resolución ni la verdad bruta de la cronología.
 */
gamesRouter.get('/:gameId/mystery', requirePlayerAuth, async (req, res, next) => {
  try {
    const mystery = await withPlayer(req as Request, (gameId, playerId) =>
      getMysteryForPlayer(gameId, playerId),
    );
    res.json(mystery);
  } catch (error) {
    next(error);
  }
});

/**
 * Iniciar partida: solo el anfitrión (validado dentro del servicio, en
 * transacción). Devuelve el estado actualizado del juego.
 */
gamesRouter.post('/:gameId/start', requirePlayerAuth, WRITE_LIMITER, async (req, res, next) => {
  try {
    const game = await withPlayer(req as Request, (gameId, playerId) =>
      startGame(gameId, playerId),
    );
    res.json({ game });
  } catch (error) {
    next(error);
  }
});

/**
 * Abandonar partida: idempotente y liberador — borra la membresía y la
 * sesión de dispositivo, así el jugador puede volver a crear/unirse.
 */
gamesRouter.post('/:gameId/leave', requirePlayerAuth, WRITE_LIMITER, async (req, res, next) => {
  try {
    await withPlayer(req as Request, (gameId, playerId) => leaveGame(gameId, playerId));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/**
 * Editar perfil: information personal + relaciones del LLAMADOR. La identidad
 * viene del token (req.player), el body del schema compartido y el resultado
 * de completitud lo calcula el backend en transacción.
 */
gamesRouter.patch(
  '/:gameId/profile',
  requirePlayerAuth,
  WRITE_LIMITER,
  parseBody(updatePlayerProfileSchema),
  async (req, res, next) => {
    try {
      const gameId = gameIdParam(req);
      const playerId = req.player?.playerId ?? '';
      if (gameId.length === 0 || playerId.length === 0) {
        throw httpError(401, 'AUTH_MISSING', 'Falta el token de acceso a la partida.');
      }
      const result = await updatePlayerProfile(
        gameId,
        playerId,
        res.locals.input as UpdatePlayerProfileInput,
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);
