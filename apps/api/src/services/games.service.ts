import { FieldValue, type DocumentData, type Transaction } from 'firebase-admin/firestore';
import type {
  CreateGameInput,
  GameSessionPayload,
  GameStatePayload,
  GameStatus,
  GameView,
  JoinGameInput,
  PlayerView,
} from '@mystery/shared';
import { MAX_PLAYERS } from '@mystery/shared';
import { getFirestoreDb } from '../db/firestore.js';
import { httpError } from '../utils/errors.js';
import { generateAccessToken, generateGameCode, hashDeviceId, hashToken } from '../utils/security.js';

// ---------------------------------------------------------------------------
// Modelo de datos en Firestore (solo accesible vía Admin SDK; las reglas
// deniegan todo acceso directo desde clientes):
//
//   games/{id}: { code, status, hostPlayerId, maxPlayers, playerCount, createdAt }
//   games/{id}/players/{playerId}: { displayName, isHost, tokenHash, deviceHash, joinedAt }
//   deviceSessions/{deviceHash}: { gameId, playerId, updatedAt }
//
// El código de invitación es compartido; el tokenHash es la credencial
// privada y jamás sale de este backend. deviceSessions es la fuente de
// verdad de "una partida activa por dispositivo": se consulta dentro de
// las mismas transacciones de create/leave, de modo que ni con peticiones
// concurrentes puede un dispositivo colarse en dos partidas.
// ---------------------------------------------------------------------------

/** Máximo de reintentos si el CSPRNG produce un código ya en uso. */
const MAX_CODE_ATTEMPTS = 5;

interface GameDoc extends DocumentData {
  code: string;
  status: GameStatus;
  hostPlayerId: string;
  maxPlayers: number;
  playerCount: number;
}

function db() {
  return getFirestoreDb();
}

function toGameView(id: string, data: GameDoc): GameView {
  return {
    id,
    code: data.code,
    status: data.status,
    hostPlayerId: data.hostPlayerId,
    maxPlayers: data.maxPlayers,
    playerCount: data.playerCount,
  };
}

function toPlayerView(id: string, displayName: string, isHost: boolean): PlayerView {
  return { id, displayName, isHost };
}

// ---------------------------------------------------------------------------
// Consulta por código dentro de una transacción: impide que dos jugadores
// creen partidas con el mismo código o que se saturen plazas de un juego con
// joins simultáneos, sin necesidad de candados externos.
// ---------------------------------------------------------------------------

function gameByCodeRef(code: string) {
  return db().collection('games').where('code', '==', code).limit(1);
}

/** Colección raíz que registra la partida activa de cada dispositivo. */
function deviceSessionRef(deviceHash: string) {
  return db().collection('deviceSessions').doc(deviceHash);
}

interface DeviceSessionDoc extends DocumentData {
  gameId: string;
  playerId: string;
}

/**
 * Un dispositivo solo puede pertenecer a una partida VIVA a la vez. Se
 * comprueba dentro de la transacción de create/join: dos joins concurrentes
 * desde el mismo dispositivo reintentan la transacción y el segundo ve el
 * registro que acaba de crear el primero → 409. Si la sesión apunta a una
 * partida que ya no existe o que está cerrada, se limpia aquí mismo (la
 * petición actual se considera libre para continuar).
 */
async function assertDeviceIsFree(tx: Transaction, deviceHash: string): Promise<void> {
  const sessionSnap = await tx.get(deviceSessionRef(deviceHash));
  if (!sessionSnap.exists) return;

  const session = sessionSnap.data() as DeviceSessionDoc;
  const gameSnap = await tx.get(db().collection('games').doc(session.gameId));
  const status = gameSnap.exists ? (gameSnap.data() as GameDoc).status : 'closed';

  if (gameSnap.exists && status !== 'closed') {
    throw httpError(
      409,
      'ALREADY_IN_GAME',
      'Ya tienes una partida activa en este dispositivo. Vuelve a ella desde el inicio.',
    );
  }

  // Tumba de una partida terminada: la referencia se recicla para esta petición.
  tx.delete(deviceSessionRef(deviceHash));
}

/**
 * Crea una partida y registra al creador como primer jugador (anfitrión).
 * Además marca al dispositivo como ocupado por esa partida (sesión activa).
 * Devuelve el payload completo: juego, jugador y token privado (una única vez).
 */
export async function createGame(input: CreateGameInput): Promise<GameSessionPayload> {
  const deviceHash = hashDeviceId(input.deviceId);

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = generateGameCode();
    const token = generateAccessToken();
    const playerId = crypto.randomUUID();

    const gameId = await db().runTransaction(async (tx) => {
      await assertDeviceIsFree(tx, deviceHash);

      const existing = await tx.get(gameByCodeRef(code));
      if (!existing.empty) {
        return null; // Colisión increíble pero posible: regenerar en el caller.
      }

      const gameRef = db().collection('games').doc(crypto.randomUUID());
      tx.create(gameRef, {
        code,
        status: 'open',
        hostPlayerId: playerId,
        maxPlayers: MAX_PLAYERS,
        playerCount: 1,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.create(gameRef.collection('players').doc(playerId), {
        displayName: input.displayName,
        isHost: true,
        tokenHash: hashToken(token),
        deviceHash,
        joinedAt: FieldValue.serverTimestamp(),
      });
      tx.create(deviceSessionRef(deviceHash), {
        gameId: gameRef.id,
        playerId,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return gameRef.id;
    });

    if (gameId) {
      return {
        game: {
          id: gameId,
          code,
          status: 'open',
          hostPlayerId: playerId,
          maxPlayers: MAX_PLAYERS,
          playerCount: 1,
        },
        player: toPlayerView(playerId, input.displayName, true),
        token,
      };
    }
  }

  // 5 colisiones seguidas con ~27M combinaciones: sería un fallo grave de
  // generación; mejor fallar ruidosamente que crear un estado dudoso.
  throw httpError(500, 'INTERNAL_ERROR', 'No se pudo generar un código de partida.');
}

/**
 * Une a un jugador a la partida abierta con el código indicado.
 * La transacción revalida sesión del dispositivo, existencia, estado y cupo
 * justo antes de escribir.
 */
export async function joinGameByCode(input: JoinGameInput): Promise<GameSessionPayload> {
  const token = generateAccessToken();
  const playerId = crypto.randomUUID();
  const deviceHash = hashDeviceId(input.deviceId);
  // Cerramos sobre variables locales para mapear el uso dentro de la transacción
  // a los valores exactos que devolvemos al cliente.
  let joinedGameId: string | null = null;
  let joinedCode: string | null = null;
  let joinedHostId: string | null = null;
  let joinedMaxPlayers = MAX_PLAYERS;
  let joinedPlayerCount = 0;

  await db().runTransaction(async (tx) => {
    // Prioridad a la restricción de sesión: si el dispositivo ya está en una
    // partida viva no revelamos nada de esta partida (ni siquiera su existencia).
    await assertDeviceIsFree(tx, deviceHash);

    const snapshot = await tx.get(gameByCodeRef(input.code));
    const gameDoc = snapshot.docs.at(0);

    if (!gameDoc) {
      // Misma respuesta aunque el código no exista: no filtra qué códigos
      // están tomados y desincentiva el sondeo de partidas ajenas.
      throw httpError(
        404,
        'GAME_NOT_FOUND',
        'No existe una partida con ese código. Revisa que esté bien escrito.',
      );
    }

    const data = gameDoc.data() as GameDoc;
    if (data.status !== 'open') {
      throw httpError(
        409,
        'GAME_CLOSED',
        'Esa partida ya no acepta nuevos jugadores.',
      );
    }

    const maxPlayers = typeof data.maxPlayers === 'number' ? data.maxPlayers : MAX_PLAYERS;
    if (data.playerCount >= maxPlayers) {
      throw httpError(
        409,
        'GAME_FULL',
        'La partida está completa. Pide al anfitrión que amplíe el cupo.',
      );
    }

    const playerRef = gameDoc.ref.collection('players').doc(playerId);
    tx.create(playerRef, {
      displayName: input.displayName,
      isHost: false,
      tokenHash: hashToken(token),
      deviceHash,
      joinedAt: FieldValue.serverTimestamp(),
    });
    tx.update(gameDoc.ref, { playerCount: FieldValue.increment(1) });
    tx.create(deviceSessionRef(deviceHash), {
      gameId: gameDoc.id,
      playerId,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Dejamos los valores disponibles para el return del caller.
    joinedGameId = gameDoc.id;
    joinedCode = data.code;
    joinedHostId = data.hostPlayerId;
    joinedMaxPlayers = maxPlayers;
    joinedPlayerCount = data.playerCount + 1;
  });

  if (!joinedGameId || !joinedCode || !joinedHostId) {
    // La transacción se reintentó y no llegó a persistir nada legible.
    throw httpError(500, 'INTERNAL_ERROR', 'No se pudo unir a la partida. Inténtalo de nuevo.');
  }

  return {
    game: {
      id: joinedGameId,
      code: joinedCode,
      status: 'open',
      hostPlayerId: joinedHostId,
      maxPlayers: joinedMaxPlayers,
      playerCount: joinedPlayerCount,
    },
    player: { id: playerId, displayName: input.displayName, isHost: false },
    token,
  };
}

/**
 * Estado completo de la partida, protegido por credencial privada.
 * Usado por el lobby; es el patrón de autorización que usarán las
 * pistas, notas y votaciones en próximas iteraciones.
 */
export async function getGameState(gameId: string, token: string): Promise<GameStatePayload> {
  const tokenHash = hashToken(token);
  const gameRef = db().collection('games').doc(gameId);
  const [gameSnap, callerSnap] = await Promise.all([
    gameRef.get(),
    gameRef.collection('players').where('tokenHash', '==', tokenHash).limit(1).get(),
  ]);

  const caller = callerSnap.docs.at(0);
  if (!caller) {
    throw httpError(401, 'AUTH_INVALID', 'No eres jugador de esta partida.');
  }
  if (!gameSnap.exists) {
    throw httpError(404, 'GAME_NOT_FOUND', 'La partida ya no existe.');
  }

  const playersSnap = await gameRef.collection('players').orderBy('joinedAt', 'asc').get();
  const gameData = gameSnap.data() as GameDoc;

  return {
    game: toGameView(gameSnap.id, gameData),
    players: playersSnap.docs.map((doc) => {
      const p = doc.data();
      return {
        id: doc.id,
        displayName: typeof p.displayName === 'string' ? p.displayName : '¿?',
        isHost: p.isHost === true,
      };
    }),
  };
}

/**
 * El creador arranca la partida: 'open' → 'in_progress'. La transacción
 * revalida que quien llama es el anfitrión y que la partida sigue abierta,
 * de modo que ni un token robado ni una UI manipulada puedan arrancar
 * el caso de otro.
 */
export async function startGame(gameId: string, playerId: string): Promise<GameView> {
  const gameRef = db().collection('games').doc(gameId);

  const started = await db().runTransaction(async (tx) => {
    const [gameSnap, callerSnap] = await Promise.all([
      tx.get(gameRef),
      tx.get(gameRef.collection('players').doc(playerId)),
    ]);

    if (!gameSnap.exists) {
      throw httpError(404, 'GAME_NOT_FOUND', 'La partida ya no existe.');
    }
    const caller = callerSnap.data() as DocumentData | undefined;
    if (!callerSnap.exists || caller?.isHost !== true) {
      throw httpError(403, 'GAME_NOT_HOST', 'Solo el creador puede iniciar la partida.');
    }

    const data = gameSnap.data() as GameDoc;
    if (data.status === 'in_progress') {
      throw httpError(409, 'GAME_IN_PROGRESS', 'La partida ya ha comenzado.');
    }
    if (data.status !== 'open') {
      throw httpError(409, 'GAME_CLOSED', 'Esta partida está cerrada y no puede iniciarse.');
    }

    tx.update(gameRef, { status: 'in_progress' });
    return toGameView(gameSnap.id, { ...data, status: 'in_progress' });
  });

  return started;
}

/**
 * Abandono explícito de la partida:
 *  - Jugador normal: se elimina su documento, se decrementa el cupo y se
 *    libera su sesión de dispositivo (puede crear/unirse a otra partida).
 *  - Anfitrión: la partida se cierra ('closed'), se eliminan TODOS los
 *    jugadores y se liberan todas las sesiones de dispositivo asociadas.
 *    El documento de la partida queda como tumba para que los demás clientes
 *    detecten el cierre en su próxima sincronización.
 */
export async function leaveGame(gameId: string, playerId: string): Promise<void> {
  const gameRef = db().collection('games').doc(gameId);

  await db().runTransaction(async (tx) => {
    const gameSnap = await tx.get(gameRef);

    if (!gameSnap.exists) {
      // Sin partida detrás (p. ej. borrada manualmente): la sesión activa del
      // dispositivo se libera igualmente; el abandono nunca debe "atar" al
      // usuario a un estado fantasma.
      return;
    }

    const callerSnap = await tx.get(gameRef.collection('players').doc(playerId));
    if (!callerSnap.exists) {
      // Ya no era jugador (abandono duplicado, partida cerrada antes...): idempotente.
      return;
    }

    const caller = callerSnap.data() as DocumentData;
    const playersSnap = await tx.get(gameRef.collection('players'));

    if (caller.isHost === true) {
      // Cierre en cascada: libera también a los demás jugadores.
      for (const doc of playersSnap.docs) {
        const player = doc.data() as DocumentData;
        if (typeof player.deviceHash === 'string') {
          tx.delete(deviceSessionRef(player.deviceHash));
        }
        tx.delete(doc.ref);
      }
      tx.update(gameRef, { status: 'closed', playerCount: 0 });
      return;
    }

    tx.delete(callerSnap.ref);
    tx.update(gameRef, { playerCount: FieldValue.increment(-1) });
    if (typeof caller.deviceHash === 'string') {
      tx.delete(deviceSessionRef(caller.deviceHash));
    }
  });
}
