import { FieldValue, type DocumentData, type Transaction } from 'firebase-admin/firestore';
import type { GameStatus, MysteryContext } from '@mystery/shared';
import { getFirestoreDb } from '../db/firestore.js';
import { env, isGenerationConfigured } from '../config/env.js';
import { httpError } from '../utils/errors.js';
import { buildMysteryContext } from './mystery-generation/context.js';
import {
  MysteryGenerationError,
  type MysteryGenerationProvider,
  type MysteryGenerationResult,
} from './mystery-generation/contract.js';
import { createRemoteMysteryProvider } from './mystery-generation/remote-provider.js';
import { createDeepseekProvider } from './mystery-generation/deepseek-provider.js';
import { validateMysteryPayload } from './mystery-generation/mystery-schema.js';
import { mysterySchema } from './mystery-generation/mystery-schema.js';
import type { MysteryDocument } from './mystery-generation/mystery-schema.js';
import type {
  MysteryPayloadView,
  MysteryClueView,
  MysteryRoomView,
  MysteryPersonalTimelinePoint,
} from '@mystery/shared';

// ---------------------------------------------------------------------------
// ORQUESTADOR del ciclo de generación del misterio.
//
// Separación de responsabilidades:
//   1. games.service.startGame()  → valida condiciones y SNAPSHOT del contexto
//     (transacción atómica; status 'open' → 'generating').
//   2. runMysteryGeneration()     → ORQUESTA: provider → VALIDACIÓN
//     (validateMysteryPayload: esquema + reglas cruzadas) → commit/fail en
//     Firestore. Corre en segundo plano: el /start responde en milisegundos
//     y el cliente sigue el progreso por sondeo del estado (GET state), así
//     una IA real con minutos de latencia no tosa hacia timeouts HTTP.
//   3. mystery-generation/*       → contrato + proveedor concreto (sustituible)
//     + el esquema del misterio (mystery-schema.ts) y los prompts.
//   4. Persistencia               → games/{id}/mystery/current + status 'ready';
//     lectura por jugador filtrada en getMysteryForPlayer (nada de la
//     solution, la resolución o los secretos ajenos viajan al cliente).
//
// Estados controlados desde aquí: 'generating' → 'ready' | 'generation_error'
// (nunca desde otro estado: las transacciones lo re-verifican de novo).
// ---------------------------------------------------------------------------

const db = () => getFirestoreDb();

/**
 * Proveedor actual (instancia única por proceso); null mientras no haya
 * configuración. La evaluación perezosa evita re-crear el objeto en cada
 * generación y centraliza aquí la elección: cambiar de IA se hace editando
 * .env (o creando otro provider y añadiéndolo aquí), sin tocar el orquestador.
 */
let providerInstance: MysteryGenerationProvider | null | undefined;

/**
 * Selector de proveedor por configuración (norma de escalabilidad):
 *   AI_GENERATION_PROVIDER=deepseek → proveedor OpenAI-compatible de DeepSeek.
 *   Vacío o cualquier otro valor    → proveedor HTTP genérico (mock local,
 *                                      scripts/mock-ai-server.mjs, etc.).
 */
function createProvider(): MysteryGenerationProvider | null {
  switch (env.generation.provider) {
    case 'deepseek':
      return createDeepseekProvider();
    default:
      return createRemoteMysteryProvider();
  }
}

function currentProvider(): MysteryGenerationProvider | null {
  if (providerInstance === undefined) {
    providerInstance = createProvider();
  }
  return providerInstance;
}

interface GenerationGameDoc extends DocumentData {
  status: GameStatus;
  mysteryContext?: MysteryContext;
  lastGenerationError?: { code: string; message: string };
}

function gameRefOf(gameId: string) {
  return db().collection('games').doc(gameId);
}

/**
 * Ejecución completa del proceso sobre una partida ya en 'generating'.
 * Nunca lanza al caller de la ruta: TODO fallo deja la partida en un estado
 * persistido y el cliente se entera por sondeo del estado.
 */
export async function runMysteryGeneration(gameId: string): Promise<void> {
  const gameRef = gameRefOf(gameId);

  // 1. Lectura del punto de partida (estado garantizado por la transacción
  //    de start; si ya no está en 'generating', alguien la cerró: no-op).
  const gameSnap = await gameRef.get();
  const data = gameSnap.data() as GenerationGameDoc | undefined;
  if (!gameSnap.exists || data?.status !== 'generating') return;

  const context = data?.mysteryContext;
  if (!context) {
    // Estado incoherente: la transacción de inicio SIEMPRE persiste el
    // snapshot del contexto. Si falta, se falla con razón concreta (los
    // perfiles originales quedan intactos y el anfitrión puede reintentar).
    await failGeneration(
      gameRef,
      'GENERATION_INTERNAL',
      'La partida entró en generación sin el contexto de los participantes.',
    );
    return;
  }

  const provider = currentProvider();
  if (!isGenerationConfigured() || !provider) {
    // CONTROLADO: integración pendiente. Nada se inventa ni se llama a nadie.
    await failGeneration(
      gameRef,
      'GENERATION_NOT_CONFIGURED',
      'No se ha podido generar el misterio. El servicio de generación no está disponible actualmente. Puedes volver a intentarlo más tarde.',
    );
    return;
  }

  // 2. Intento de generación + VALIDACIÓN del misterio contra el contexto real.
  try {
    const rawPayload = await provider.generate({ context });

    // VALIDACIÓN (FASE 5): el JSON del proveedor debe cumplir el esquema del
    // misterio Y las reglas cruzadas (una víctima jugable, un asesino
    // coherente, playerIds cubiertos...). Se persiste la copia normalizada.
    const validation = validateMysteryPayload(rawPayload, context);
    if (!validation.ok) {
      // Detalle completo a los registros del servidor; a la partida solo
      // llega la razón legible para el banner del lobby.
      console.error(
        `[api] misterio inválido para ${gameId}:\n- ${validation.issues.join('\n- ')}`,
      );
      throw new MysteryGenerationError(
        'GENERATION_INVALID_RESPONSE',
        'El misterio generado no superó la validación del esquema y se descartó. Puedes volver a intentarlo.',
      );
    }

    // 3. Persistencia del resultado (transacción con re-verificación de estado:
    //    si el anfitrión abandonó durante el proceso, se descarta en paz).
    const result: MysteryGenerationResult = {
      provider: provider.name,
      payload: validation.mystery,
      generatedAt: new Date(),
    };
    await db().runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(gameRef);
      const current = snap.data() as GenerationGameDoc | undefined;
      if (!snap.exists || current?.status !== 'generating') return;
      tx.set(gameRef.collection('mystery').doc('current'), {
        provider: result.provider,
        payload: result.payload,
        generatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(gameRef, {
        status: 'ready',
        lastGenerationError: FieldValue.delete(),
      });
    });
    console.log(`[api] misterio de ${gameId} generado y almacenado.`);
  } catch (cause) {
    const failure = cause instanceof MysteryGenerationError
      ? cause
      : new MysteryGenerationError(
          'GENERATION_INTERNAL',
          'Error inesperado durante la generación del misterio.',
        );
    console.error(`[api] generación falló (${failure.code}):`, failure.message);
    await failGeneration(gameRef, failure.code, failure.message);
  }
}

/**
 * Carga y VALIDA games/{id}/mystery/current (compartido por la vista del
 * misterio y por el servicio de investigación):
 *   · La partida debe existir y estar 'ready' (o 'in_progress' por
 *     compatibilidad); en otro caso lanza los mismos errores controlados.
 *   · Re-parsea el payload con el esquema: Firestore solo es legible a
 *     través del SDK Admin, pero esto blindaría un documento corrupto.
 */
export async function loadValidatedMystery(gameId: string): Promise<MysteryDocument> {
  const gameRef = gameRefOf(gameId);
  const gameSnap = await gameRef.get();
  if (!gameSnap.exists) {
    throw httpError(404, 'GAME_NOT_FOUND', 'La partida ya no existe.');
  }
  const gameData = gameSnap.data() as GenerationGameDoc | undefined;
  const status = gameData?.status;
  if (status !== 'ready' && status !== 'in_progress') {
    throw httpError(
      409,
      'MYSTERY_NOT_READY',
      status === 'generating'
        ? 'El misterio todavía se está generando. Espera a que termine el proceso.'
        : 'El misterio aún no está preparado: el anfitrión debe primero iniciarlo.',
    );
  }

  const mysterySnap = await gameRef.collection('mystery').doc('current').get();
  if (!mysterySnap.exists) {
    throw httpError(404, 'MYSTERY_NOT_READY', 'El misterio todavía no está disponible.');
  }
  const rawPayload = (mysterySnap.data() ?? {}).payload;
  const parsed = mysterySchema.safeParse(rawPayload);
  if (!parsed.success) {
    console.error(
      `[api] mystery/current de ${gameId} no pasa el esquema:\n- ` +
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n- '),
    );
    throw httpError(
      500,
      'INTERNAL_ERROR',
      'El misterio almacenado está en un formato no válido. El anfitrión puede volver a generarlo.',
    );
  }
  return parsed.data;
}

/**
 * VISTA del misterio PARA EL JUGADOR que llama (FASE 6).
 *
 * Doble filtro defensivo antes de enviar nada al cliente:
 *   · La partida debe estar 'ready' (o la compatibilidad 'in_progress') y el
 *     documento mystery/current debe existir y pasar el esquema de nuevo
 *     (el almacenamiento es trustworthy pero Firestore no es de confianza).
 *   · Del payload SOLO viajan: contenido compartido (title/setting/synopsis,
 *     victim deathDetail), SU personaje completo (su privateInfo/secrets/
 *     objectives/personalTimeline), el info pública del resto, y las pistas
 *     de SU alcance SOLO con el nombre (el CONTENIDO de una pista sale del
 *     backend al descubrirla, § investigación). La solution, la resolución
 *     y la verdad bruta de la cronología jamás viajan al cliente.
 */
export async function getMysteryForPlayer(
  gameId: string,
  playerId: string,
): Promise<MysteryPayloadView> {
  const mystery = await loadValidatedMystery(gameId);

  const mine = mystery.characters.find((character) => character.playerId === playerId);
  if (!mine) {
    // Partición defendible: el playerId autenticado no quedó representado
    // (p. ej. entrada después de la generación del snapshot).
    throw httpError(401, 'AUTH_INVALID', 'Tu credencial ya no es válida para esta partida.');
  }

  // Pistas visibles: scan "*" (pública), hallazgo privado del llamador; y
  // conocidas de antemano por SU personaje (knownToMe para refuerzo en UI).
  const canSeeClue = (discoveredBy: string): boolean =>
    discoveredBy === '*' || discoveredBy === playerId;
  const roomsView: MysteryRoomView[] = mystery.rooms.map((room) => ({
    roomId: room.roomId,
    name: room.name,
    description: room.description,
    clues: room.clues
      .filter((clue) => canSeeClue(clue.discoveredBy))
      .map(
        (clue): MysteryClueView => ({
          clueId: clue.clueId,
          // SOLO el nombre: el contenido viaja al descubrir (transacción)
          // o dentro de myDiscoveredClues del estado de investigación.
          name: clue.name,
          knownToMe: clue.knownTo.includes(mine.characterId),
        }),
      ),
  }));

  return {
    title: mystery.title,
    setting: mystery.setting,
    synopsis: mystery.synopsis,
    victim: { name: mystery.victim.name, deathDetail: mystery.victim.deathDetail },
    myCharacter: {
      characterId: mine.characterId,
      playerId: mine.playerId,
      name: mine.name,
      description: mine.description,
      publicInfo: mine.publicInfo,
      privateInfo: mine.privateInfo,
      secrets: mine.secrets,
      objectives: mine.objectives,
      // Cronología individual: privada y solo de SU personaje.
      personalTimeline: mine.personalTimeline satisfies MysteryPersonalTimelinePoint[],
      isVictim: mine.isVictim,
      // El rol de asesino/cómplice solo viaja a quien lo desempeña: el resto
      // del grupo no puede verlo en el payload (ni por inspección de red).
      ...(mine.isMurderer ? { isMurderer: true } : null),
      ...(mine.isAccomplice ? { isAccomplice: true } : null),
    },
    otherCharacters: mystery.characters
      .filter((character) => character.characterId !== mine.characterId)
      .map((character) => ({
        characterId: character.characterId,
        playerId: character.playerId,
        name: character.name,
        description: character.description,
        publicInfo: character.publicInfo,
      })),
    rooms: roomsView,
    // El evento objetivo (la verdad del GM) NO viaja: solo lo que los
    // jugadores pueden llegar a saber del momento.
    timeline: mystery.timeline.map((point) => ({
      time: point.time,
      publicKnowledge: point.publicKnowledge,
    })),
  };
}

/** Transición 'generating' → 'generation_error' + razón legible para la UI. */
async function failGeneration(
  gameRef: ReturnType<typeof gameRefOf>,
  code: string,
  message: string,
): Promise<void> {
  await db().runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(gameRef);
    const current = snap.data() as GenerationGameDoc | undefined;
    if (!snap.exists || current?.status !== 'generating') return;
    tx.update(gameRef, {
      status: 'generation_error',
      // Contexto PRESERVADO: los perfiles originales no se pierden por el
      // fallo; el reintento reconstruirá desde los datos actuales.
      lastGenerationError: { code, message },
    });
  });
}

/**
 * Lectura controlada del último error de generación para el payload del
 * estado (solo lectura; el cliente no ve datos del proveedor, solo razón).
 */
export function readGenerationError(data: DocumentData): {
  code: string;
  message: string;
} | null {
  const raw = data.lastGenerationError;
  if (typeof raw !== 'object' || raw === null) return null;
  const code = typeof raw.code === 'string' ? raw.code : 'GENERATION_INTERNAL';
  const message = typeof raw.message === 'string' ? raw.message : 'Error desconocido de generación.';
  return { code, message };
}

// Re-export para que la ruta de inicio construya el snapshot sin duplicación.
export { buildMysteryContext };
