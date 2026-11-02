import type { NextFunction, Request, Response } from 'express';
import { getFirestoreDb } from '../db/firestore.js';
import { httpError } from '../utils/errors.js';
import { hashToken, TOKEN_PATTERN } from '../utils/security.js';

export interface PlayerIdentity {
  gameId: string;
  playerId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      player?: PlayerIdentity;
    }
  }
}

/**
 * Autorización por credencial privada: el cliente envía su token en el
 * header Authorization y el backend comprueba el hash contra la partida
 * indicada. Nunca se acepta un jugador "por confianza" en el gameId.
 */
export async function requirePlayerAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // En Express 5 los params tipifican como string | string[] (wildcards);
    // esta ruta solo usa params simples, pero el tipo lo exige.
    const rawGameId = req.params.gameId ?? '';
    const gameId = Array.isArray(rawGameId) ? (rawGameId[0] ?? '') : rawGameId;
    if (gameId.length === 0) {
      throw httpError(400, 'VALIDATION_ERROR', 'Falta el identificador de la partida.');
    }

    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    const tokenNormalized = typeof token === 'string' ? token.trim().toLowerCase() : '';

    if (scheme !== 'Bearer' || !TOKEN_PATTERN.test(tokenNormalized)) {
      throw httpError(401, 'AUTH_MISSING', 'Falta el token de acceso a la partida.');
    }

    const snapshot = await getFirestoreDb()
      .collection('games')
      .doc(gameId)
      .collection('players')
      .where('tokenHash', '==', hashToken(tokenNormalized))
      .limit(1)
      .get();

    const player = snapshot.docs.at(0);
    if (!player) {
      throw httpError(401, 'AUTH_INVALID', 'La credencial no corresponde a esta partida.');
    }

    req.player = { gameId, playerId: player.id };
    next();
  } catch (error) {
    next(error);
  }
}

