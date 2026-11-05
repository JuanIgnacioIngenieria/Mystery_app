import { FieldValue, type DocumentData, type Timestamp, type Transaction } from 'firebase-admin/firestore';
import type {
  CreateGameInput,
  GameSessionPayload,
  GameStatePayload,
  GameStatus,
  GameView,
  JoinGameInput,
  MysteryContext,
  PlayerView,
} from '@mystery/shared';
import { MAX_PLAYERS, MIN_PLAYERS } from '@mystery/shared';
import { getFirestoreDb } from '../db/firestore.js';
import { env, isGenerationConfigured } from '../config/env.js';
import { httpError } from '../utils/errors.js';
import { generateAccessToken, generateGameCode, hashDeviceId, hashToken } from '../utils/security.js';
import type {
  PlayerProfile,
  PlayerRelation,
  UpdatePlayerProfileInput,
  UpdateProfilePayload,
} from '@mystery/shared';
import { readGenerationError, runMysteryGeneration } from './mystery.service.js';
import { buildMysteryContext } from './mystery-generation/context.js';

// ---------------------------------------------------------------------------
// Modelo de datos en Firestore (solo accesible vía Admin SDK; las reglas
// deniegan todo acceso directo desde clientes):
//
//   games/{id}: { code, status, hostPlayerId, maxPlayers, playerCount, createdAt,
//                 mysteryContext?,        // snapshot del contexto (solo en generating+)
//                 generationStartedAt?,   // detecta generaciones huérfanas
//                 lastGenerationError? }  // razón legible del último fallo
//   games/{id}/players/{playerId}: {
//     displayName, isHost, tokenHash, deviceHash, joinedAt,
//     profile?: PlayerProfile,               // información personal (6 campos)
//     relations?: { [targetPlayerId]: { level 0-10, description } },  // valoraciones propias
//     profileCompleted?: boolean,            // decide el indicador del lobby
//   }
//   games/{id}/mystery/current: { provider, payload, generatedAt }
//   deviceSessions/{deviceHash}: { gameId, playerId, updatedAt }
//
// Cada jugador solo actualiza SU documento: las relaciones viajan dentro del
// documento de quien las establece (from implícito), así un escritor nunca
// pisa los datos de otro. getGameState devuelve el perfil/relations SOLO del
// jugador que llama: el contenido personal de los demás nunca se transmite
// (y el mysteryContext tampoco: contiene los perfiles de TODOS).
//
// El código de invitación es compartido; el tokenHash es la credencial
// privada y jamás sale de este backend. deviceSessions es la fuente de
// verdad de "una partida activa por dispositivo": se consulta dentro de
// las mismas transacciones de create/leave, de modo que ni con peticiones
// concurrentes puede un dispositivo colarse en dos partidas.
// ---------------------------------------------------------------------------

/** Máximo de reintentos si el CSPRNG produce un código ya en uso. */
const MAX_CODE_ATTEMPTS = 5;

export interface GameDoc extends DocumentData {
  code: string;
  status: GameStatus;
  hostPlayerId: string;
  maxPlayers: number;
  playerCount: number;
  /** Snapshot del contexto congelado al iniciar la generación. */
  mysteryContext?: MysteryContext;
  /** Marca temporal del último intento de generación. */
  generationStartedAt?: Timestamp;
  /** Último fallo de generación (razón legible para la UI). */
  lastGenerationError?: { code: string; message: string };
}

/** Documento de jugador: perfil y relaciones viven en el doc de quien las crea. */
export interface PlayerDoc extends DocumentData {
  displayName: string;
  isHost: boolean;
  profile?: PlayerProfile;
  relations?: Record<string, PlayerRelation>;
  profileCompleted?: boolean;
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

    // Un nuevo jugador implica valoraciones pendientes para quien ya estaba:
    // si su perfil estaba completo se marca INCOMPLETO (no se borra nada de
    // su información, solo la bandera). En la misma transacción: sin carreras
    // y consistente para todos los clientes.
    const existingPlayers = await tx.get(gameDoc.ref.collection('players'));
    for (const doc of existingPlayers.docs) {
      const player = doc.data() as PlayerDoc;
      if (player.profileCompleted === true) {
        tx.update(doc.ref, { profileCompleted: false });
      }
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
  const callerData = caller.data() as PlayerDoc;

  return {
    game: toGameView(gameSnap.id, gameData),
    players: playersSnap.docs.map((doc) => {
      const p = doc.data() as PlayerDoc;
      return {
        id: doc.id,
        displayName: typeof p.displayName === 'string' ? p.displayName : '¿?',
        isHost: p.isHost === true,
        // Flag persistido por el backend al guardar el perfil; undefined =
        // perfil sin tocar (indicador gris en el lobby).
        profileCompleted: typeof p.profileCompleted === 'boolean' ? p.profileCompleted : undefined,
      };
    }),
    // El contenido personal viaja ÚNICAMENTE para quien llama: los perfiles
    // de otros jugadores no se exponen (privacidad y más pequeña la carga).
    myProfile: isProfileShape(callerData.profile)
      ? sanitizeProfile(callerData.profile)
      : null,
    myRelations: sanitizeRelations(callerData.relations),
    // Razón del último fallo de generación: alimenta el mensaje junto al
    // botón de inicio. Es estado interno persistido, no datos del proveedor.
    lastGenerationError: readGenerationError(gameData),
  };
}

/** Chequeo defensivo de documentos antiguos/foráneos en Firestore. */
function isProfileShape(value: unknown): value is PlayerProfile {
  return (
    typeof value === 'object' &&
    value !== null &&
    ['aboutMe', 'job', 'clothing', 'hobbies', 'drinks', 'fears'].every(
      (field) => typeof (value as Record<string, unknown>)[field] === 'string',
    )
  );
}

function sanitizeProfile(profile: PlayerProfile): PlayerProfile {
  const pick = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    aboutMe: pick(profile.aboutMe),
    job: pick(profile.job),
    clothing: pick(profile.clothing),
    hobbies: pick(profile.hobbies),
    drinks: pick(profile.drinks),
    fears: pick(profile.fears),
  };
}

function sanitizeRelations(
  relations: PlayerDoc['relations'],
): Record<string, PlayerRelation> {
  const output: Record<string, PlayerRelation> = {};
  if (typeof relations !== 'object' || relations === null) return output;
  for (const [targetId, raw] of Object.entries(relations)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const candidate = raw as { level?: unknown; description?: unknown };
    const level = typeof candidate.level === 'number' && Number.isInteger(candidate.level)
      && candidate.level >= 0 && candidate.level <= 10
      ? candidate.level
      : null;
    if (level === null) continue; // Valoración corrupta: se descarta, no se inventa.
    output[targetId] = {
      level,
      description: typeof candidate.description === 'string' ? candidate.description : '',
    };
  }
  return output;
}

/**
 * Guarda el perfil del LLAMADOR (nunca de otro): information personal +
 * valoraciones/relaciones. En la misma transacción decide si el perfil está
 * COMPLETO (seis campos con contenido y una valoración por cada uno de los
 * demás jugadores actuales) y persiste la bandera profileCompleted. El
 * cliente solo sabe el resultado; la fuente de verdad es Firestore.
 */
export async function updatePlayerProfile(
  gameId: string,
  playerId: string,
  input: UpdatePlayerProfileInput,
): Promise<UpdateProfilePayload> {
  return db().runTransaction(async (tx) => {
    const gameRef = db().collection('games').doc(gameId);
    const [gameSnap, playersSnap, playerSnap] = await Promise.all([
      tx.get(gameRef),
      tx.get(gameRef.collection('players')),
      tx.get(gameRef.collection('players').doc(playerId)),
    ]);

    if (!gameSnap.exists) {
      throw httpError(404, 'GAME_NOT_FOUND', 'La partida ya no existe.');
    }
    if (!playerSnap.exists) {
      throw httpError(401, 'AUTH_INVALID', 'Tu credencial ya no es válida.');
    }

    // Durante la generación el contexto YA ESTÁ CONGELADO (snapshot de la
    // transacción de inicio): editar perfiles ahora rompería la coherencia
    // entre el misterio que se fabrica y los datos vivos. En cuanto termine
    // ('ready' o 'generation_error') se vuelve a permitir editar.
    const gameData = gameSnap.data() as GameDoc;
    if (gameData.status === 'generating') {
      throw httpError(
        409,
        'GENERATION_IN_PROGRESS',
        'El misterio se está generando: no se pueden modificar los perfiles hasta que termine.',
      );
    }

    const otherIds = new Set(
      playersSnap.docs.filter((doc) => doc.id !== playerId).map((doc) => doc.id),
    );

    const relations: Record<string, PlayerRelation> = {};
    for (const [targetId, relation] of Object.entries(input.relations)) {
      if (targetId === playerId) {
        throw httpError(400, 'VALIDATION_ERROR', 'No puedes valorarte a ti mismo.');
      }
      if (!otherIds.has(targetId)) {
        throw httpError(
          400,
          'VALIDATION_ERROR',
          'Has valorado a un jugador que ya no está en la partida. Revisa las relaciones.',
        );
      }
      relations[targetId] = { level: relation.level, description: relation.description };
    }

    // Completitud: todos los campos personales con contenido + valoración
    // (o-10) por cada OTRO jugador de la partida en este momento. La
    // "relación especial" (descripción) es opcional: no todo el mundo tiene
    // vínculos destacados, por eso solo se exige el nivel.
    const profile: PlayerProfile = input.profile;
    const personalComplete = Object.values(profile).every((field) => field.length > 0);
    const relationsComplete = otherIds.size === Object.keys(relations).length;
    const profileCompleted = personalComplete && relationsComplete;

    tx.update(playerSnap.ref, {
      profile,
      relations,
      profileCompleted,
      profileUpdatedAt: FieldValue.serverTimestamp(),
    });

    return { profileCompleted };
  });
}

/**
 * Umbral tras el cual una partida atascada en 'generating' se considera
 * huérfana (p. ej. proceso reiniciado a mitad de generación) y un nuevo
 * /start puede recuperar la partida: timeout del proveedor + margen de
 * gracia. Garantiza que ningún fallo deje la partida bloqueada para siempre.
 */
const GENERATION_STALE_MS = env.generation.timeoutMs + 60_000;

/**
 * El creador arranca la preparación del misterio. La transacción revalida
 * TODO (anfitrión, estado, cupo mínimo, perfiles completos) y congela un
 * SNAPSHOT consistente de los datos (mysteryContext) antes de transicionar
 * 'open' | 'generation_error' → 'generating'. La generación en sí corre en
 * SEGUNDO PLANO (runMysteryGeneration): este endpoint responde en milisegundos
 * y los clientes siguen el proceso por sondeo del estado (GET /state).
 *
 * - Ni un token robado ni una UI manipulada pueden iniciar la partida sin
 *   ser anfitrión: se re-verifica dentro de la transacción.
 * - Dos /start concurrentes: la transacción re-ejecuta y el segundo ve el
 *   estado 'generating' que persistió el primero → 409.
 * - Generación huérfana (proceso caído): superado GENERATION_STALE_MS se
 *   permite reintentar en lugar de dejar la partida bloqueada para siempre.
 */
export async function startGame(gameId: string, playerId: string): Promise<GameView> {
  // Error controlado e inmediato (§ integración IA): sin proveedor no se
  // transiciona a 'generating' para un intento condenado de antemano.
  if (!isGenerationConfigured()) {
    throw httpError(
      503,
      'GENERATION_NOT_CONFIGURED',
      'No se ha podido generar el misterio. El servicio de generación no está disponible actualmente. Puedes volver a intentarlo más tarde.',
    );
  }

  const gameRef = db().collection('games').doc(gameId);

  const started = await db().runTransaction(async (tx) => {
    const [gameSnap, callerSnap, playersSnap] = await Promise.all([
      tx.get(gameRef),
      tx.get(gameRef.collection('players').doc(playerId)),
      tx.get(gameRef.collection('players')),
    ]);

    if (!gameSnap.exists) {
      throw httpError(404, 'GAME_NOT_FOUND', 'La partida ya no existe.');
    }
    const caller = callerSnap.data() as DocumentData | undefined;
    if (!callerSnap.exists || caller?.isHost !== true) {
      throw httpError(403, 'GAME_NOT_HOST', 'Solo el anfitrión puede comenzar la partida.');
    }

    const data = gameSnap.data() as GameDoc;
    if (data.status === 'generating') {
      // Generación en curso: solo se puede reintentar si el intento previo
      // es huérfano (más antiguo que el presupuesto de espera + gracia).
      const startedAt = data.generationStartedAt;
      const elapsedMs = startedAt?.toDate
        ? Date.now() - startedAt.toDate().getTime()
        : Number.POSITIVE_INFINITY;
      if (elapsedMs < GENERATION_STALE_MS) {
        throw httpError(
          409,
          'GENERATION_IN_PROGRESS',
          'El misterio ya se está generando. Espera a que termine el proceso.',
        );
      }
    } else if (data.status === 'ready' || data.status === 'in_progress') {
      throw httpError(409, 'GAME_IN_PROGRESS', 'El misterio de esta partida ya está preparado.');
    } else if (data.status !== 'open' && data.status !== 'generation_error') {
      throw httpError(409, 'GAME_CLOSED', 'Esta partida está cerrada y no puede iniciarse.');
    }

    // Condiciones de inicio (§ nuevo requisito): mínimo de participantes y
    // TODOS los perfiles completos (la bandera la calcula y persiste el
    // backend al guardar cada perfil; un join reciente la resetea en los
    // demás dentro de la misma transacción).
    if (playersSnap.docs.length < MIN_PLAYERS) {
      throw httpError(
        409,
        'GAME_NOT_READY',
        `Se necesitan al menos ${MIN_PLAYERS} jugadores para comenzar la partida.`,
      );
    }
    const pendingProfiles = playersSnap.docs.filter(
      (doc) => (doc.data() as PlayerDoc).profileCompleted !== true,
    );
    if (pendingProfiles.length > 0) {
      throw httpError(
        409,
        'GAME_NOT_READY',
        'Todos los jugadores deben completar su perfil antes de comenzar la partida.',
      );
    }

    // Snapshot CONSISTENTE: el contexto se construye solo con la copia leída
    // aquí. Joins o ediciones posteriores no pueden alterar esta generación.
    const context = buildMysteryContext(gameSnap, playersSnap.docs);

    tx.update(gameRef, {
      status: 'generating',
      mysteryContext: context,
      generationStartedAt: FieldValue.serverTimestamp(),
      lastGenerationError: FieldValue.delete(),
    });
    return toGameView(gameSnap.id, { ...data, status: 'generating' });
  });

  // El proceso corre en segundo plano: nunca bloquea la respuesta HTTP ni
  // depende de que el anfitrión siga conectado. runMysteryGeneration no lanza
  // (todo fallo persiste 'generation_error'); el catch es un cinturón extra
  // para no dejar un unhandled rejection si algo se escapa.
  void runMysteryGeneration(gameId).catch((error) => {
    console.error('[api] fallo inesperado del orquestador de generación:', error);
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
