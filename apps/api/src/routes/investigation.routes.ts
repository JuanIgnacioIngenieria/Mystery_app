import type { NotebookUpdateInput } from '@mystery/shared';
import { notebookUpdateSchema } from '@mystery/shared';
import { Router } from 'express';
import { requirePlayerAuth } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import {
  claimClue,
  getInvestigationState,
  getNotebook,
  releaseClue,
  revealClue,
  saveNotebook,
} from '../services/investigation.service.js';
import { httpError } from '../utils/errors.js';
import { gameIdParam, parseBody, withPlayer } from '../utils/request-helpers.js';

/**
 * RUTAS DE LA FASE DE INVESTIGACIÓN (montadas bajo /api/games):
 *
 *   GET  /:gameId/investigation          → estado (pistas + pistas propias + cuaderno)
 *   POST /:gameId/clues/:clueId/claim    → RESERVA atómica (transacción Firestore)
 *   POST /:gameId/clues/:clueId/reveal   → confirmación + contenido íntegro
 *   POST /:gameId/clues/:clueId/release  → liberación de la reserva propia
 *   GET/PUT /:gameId/notebook            → cuaderno privado del llamador
 *
 * La identidad (gameId + playerId) SIEMPRE se resuelve del token y del path
 * (requirePlayerAuth + withPlayer): nunca del body. Las operaciones que
 * mutan Firestore pasan por el limitador (reservar diasparadas es abuso,
 * y el autoguardado del cuaderno usa su propia cuota generosa).
 */
const ACTION_LIMITER = createRateLimiter({ windowMs: 60_000, max: 60 });

/** clueId llega por path: validamos forma antes de tocar Firestore. */
const CLUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function clueIdParam(req: { params: Record<string, unknown> }): string {
  const raw = req.params.clueId ?? '';
  const clueId = Array.isArray(raw) ? (raw[0] ?? '') : raw;
  if (!CLUE_ID_PATTERN.test(clueId)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Identificador de pista no válido.');
  }
  return clueId;
}

export const investigationRouter = Router();

/** Estado completo de la investigación para el jugador que llama. */
investigationRouter.get('/:gameId/investigation', requirePlayerAuth, async (req, res, next) => {
  try {
    const state = await withPlayer(req, (gameId, playerId) =>
      getInvestigationState(gameId, playerId),
    );
    res.json(state);
  } catch (error) {
    next(error);
  }
});

investigationRouter.post(
  '/:gameId/clues/:clueId/claim',
  requirePlayerAuth,
  ACTION_LIMITER,
  async (req, res, next) => {
    try {
      const result = await withPlayer(req, (gameId, playerId) =>
        claimClue(gameId, playerId, clueIdParam(req)),
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
);

investigationRouter.post(
  '/:gameId/clues/:clueId/reveal',
  requirePlayerAuth,
  ACTION_LIMITER,
  async (req, res, next) => {
    try {
      const result = await withPlayer(req, (gameId, playerId) =>
        revealClue(gameId, playerId, clueIdParam(req)),
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

investigationRouter.post(
  '/:gameId/clues/:clueId/release',
  requirePlayerAuth,
  ACTION_LIMITER,
  async (req, res, next) => {
    try {
      const result = await withPlayer(req, (gameId, playerId) =>
        releaseClue(gameId, playerId, clueIdParam(req)),
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

/** Cuaderno privado: GET (carga) y PUT (autoguardado), solo del llamador. */
investigationRouter.get('/:gameId/notebook', requirePlayerAuth, async (req, res, next) => {
  try {
    const notebook = await withPlayer(req, (gameId, playerId) => getNotebook(gameId, playerId));
    res.json(notebook);
  } catch (error) {
    next(error);
  }
});

investigationRouter.put(
  '/:gameId/notebook',
  requirePlayerAuth,
  ACTION_LIMITER,
  parseBody(notebookUpdateSchema),
  async (req, res, next) => {
    try {
      const input = res.locals.input as NotebookUpdateInput;
      const result = await withPlayer(req, (gameId, playerId) =>
        saveNotebook(gameId, playerId, input),
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);
