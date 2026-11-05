import { FieldValue, type DocumentData, type Timestamp, type Transaction } from 'firebase-admin/firestore';
import type {
  ClueClaimPayload,
  ClueRevealPayload,
  DiscoveredClueView,
  InvestigationStatePayload,
  MysteryClueStateView,
  NotebookView,
  NotebookUpdateInput,
  NotebookWritePayload,
} from '@mystery/shared';
import { NOTEBOOK_TEXT_MAX } from '@mystery/shared';
import { mysterySchema, type MysteryDocument } from './mystery-generation/mystery-schema.js';
import { loadValidatedMystery } from './mystery.service.js';
import { getFirestoreDb } from '../db/firestore.js';
import { httpError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// FASE DE INVESTIGACIÓN: reservas y descubrimiento atómico de pistas.
//
// Modelo de datos (solo vía Admin SDK; las reglas de Firestore deniegan todo):
//
//   games/{id}/clues/{clueId}:
//     { status: 'reserved' | 'discovered',
//       byPlayerId: string,
//       reservedAt?:   Timestamp,   // solo en 'reserved'
//       discoveredAt?: Timestamp }  // solo en 'discovered'
//
//   games/{id}/notebooks/{playerId}:
//     { content: string, updatedAt: Timestamp }
//
// GARANTÍA "una pista, un descubridor": la decisión vive en una TRANSACCIÓN
// de Firestore. Dos jugadores que aprietan "descubrir" a la vez re-ejecutan
// la transacción en serie: el primero reserva/descubre, el segundo encuentra
// el documento del primero y recibe CLUE_UNAVAILABLE. El estado local del
// móvil nunca decide nada.
//
// RESERVAS con vida limitada: claim reserva, reveal confirma. Si la app muere
// entre ambas (desconexión, cierre inesperado), la reserva EXPIRA sola tras
// CLAIM_TTL_MS y otra jugadora puede tomarla (la transacción compara la hora
// de la reserva; nunca queda bloqueada indefinidamente).
//
// Lecturas filtradas: getInvestigationState solo devuelve estados de pistas
// elegibles para el llamador y las pistas descubiertas por ÉL; el contenido
// íntegro de una pista solo viaja en revealClue o como pista propia ya
// descubierta. Notebooks: cada jugador solo accede al suyo.
// ---------------------------------------------------------------------------

const db = () => getFirestoreDb();

/** Tiempo máximo que puede estar "colgada" una reserva sin confirmar. */
export const CLAIM_TTL_MS = 90_000;

function gameRefOf(gameId: string) {
  return db().collection('games').doc(gameId);
}

interface ClueReservationDoc extends DocumentData {
  status: 'reserved' | 'discovered';
  byPlayerId: string;
  reservedAt?: Timestamp;
  discoveredAt?: Timestamp;
}

interface GameStatusDoc extends DocumentData {
  status?: string;
}

/** Localiza una pista en el misterio; devuelve pista y habitación a la que pertenece. */
function findClue(
  mystery: MysteryDocument,
  clueId: string,
): { clue: MysteryDocument['rooms'][number]['clues'][number]; roomId: string } | null {
  for (const room of mystery.rooms) {
    const clue = room.clues.find((candidate) => candidate.clueId === clueId);
    if (clue) return { clue, roomId: room.roomId };
  }
  return null;
}

/** Elegibilidad: las pistas "privadas" solo las puede hallar su jugador. */
function isEligible(discoveredBy: string, playerId: string): boolean {
  return discoveredBy === '*' || discoveredBy === playerId;
}

/**
 * Comprobación común dentro de la transacción: partida jugable + misterio
 * válido + pista existente y elegible para el llamador. Devuelve lo que la
 * operación necesita (mystery y referencia del documento de reserva).
 */
async function assertClaimableInTx(
  tx: Transaction,
  gameId: string,
  playerId: string,
  clueId: string,
) {
  const gameRef = gameRefOf(gameId);
  const gameSnap = await tx.get(gameRef);
  if (!gameSnap.exists) {
    throw httpError(404, 'GAME_NOT_FOUND', 'La partida ya no existe.');
  }
  const status = (gameSnap.data() as GameStatusDoc | undefined)?.status;
  if (status !== 'ready' && status !== 'in_progress') {
    throw httpError(
      409,
      'MYSTERY_NOT_READY',
      status === 'generating'
        ? 'El misterio todavía se está generando. Espera a que termine el proceso.'
        : 'El misterio de esta partida ya no está disponible.',
    );
  }

  const mysterySnap = await tx.get(gameRef.collection('mystery').doc('current'));
  if (!mysterySnap.exists) {
    throw httpError(404, 'MYSTERY_NOT_READY', 'El misterio todavía no está disponible.');
  }
  const parsed = mysterySchema.safeParse((mysterySnap.data() ?? {}).payload);
  if (!parsed.success) {
    console.error(
      `[api] mystery/current de ${gameId} no pasa el esquema (investigación):\n- ` +
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n- '),
    );
    throw httpError(500, 'INTERNAL_ERROR', 'El misterio almacenado está en un formato no válido.');
  }
  const mystery = parsed.data;

  const found = findClue(mystery, clueId);
  if (!found) {
    throw httpError(404, 'CLUE_UNAVAILABLE', 'Esa pista no existe en este misterio.');
  }
  if (!isEligible(found.clue.discoveredBy, playerId)) {
    // Doble comprobación por si alguien manipula la app: solo el jugador
    // designado (o cualquiera, si es pública) la puede descubrir.
    throw httpError(403, 'CLUE_UNAVAILABLE', 'Esa pista no está a tu alcance.');
  }
  return { mystery, found, clueRef: gameRef.collection('clues').doc(clueId) };
}

/** ¿La reserva sigue siendo fresca? (las expiradas se pueden tomar de nuevo) */
function reservationIsFresh(doc: ClueReservationDoc): boolean {
  if (doc.status !== 'reserved' || !doc.reservedAt?.toDate) return false;
  return Date.now() - doc.reservedAt.toDate().getTime() < CLAIM_TTL_MS;
}

/**
 * RESERVA (paso 1 del descubrimiento). Transacción: comprueba disponibilidad
 * y escribe la reserva con sello temporal. Respuestas concurrentes: si otro
 * jugador reservó primero y su reserva está viva, el caller recibe 409.
 */
export async function claimClue(
  gameId: string,
  playerId: string,
  clueId: string,
): Promise<ClueClaimPayload> {
  await db().runTransaction(async (tx: Transaction) => {
    const { clueRef } = await assertClaimableInTx(tx, gameId, playerId, clueId);

    const docSnap = await tx.get(clueRef);
    if (docSnap.exists) {
      const doc = docSnap.data() as ClueReservationDoc;
      if (doc.status === 'discovered') {
        if (doc.byPlayerId !== playerId) {
          throw httpError(
            409,
            'CLUE_UNAVAILABLE',
            'Esta pista ya ha sido descubierta por otro jugador.',
          );
        }
        // Ya es suya (doble toque): idempotente, la reserva continúa.
        return;
      }
      const fresh = reservationIsFresh(doc);
      if (fresh && doc.byPlayerId !== playerId) {
        throw httpError(
          409,
          'CLUE_UNAVAILABLE',
          'Otro jugador está reservando esta pista en este momento. Inténtalo en unos segundos.',
        );
      }
      // Reserva propia (reclick) o reserva EXPIRADA: tomar de nuevo.
      // set() sin merge SOBREESCRIBE el documento entero: cualquier
      // discoveredAt previo desaparece (no cabe FieldValue.delete aquí).
      tx.set(clueRef, {
        status: 'reserved',
        byPlayerId: playerId,
        reservedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    tx.set(clueRef, {
      status: 'reserved',
      byPlayerId: playerId,
      reservedAt: FieldValue.serverTimestamp(),
    });
  });
  return { status: 'reserved' };
}

/**
 * CONFIRMACIÓN (paso 2): convierte la reserva propia y fresca del llamador
 * en descubrimiento PERMANENTE y devuelve el contenido íntegro de la pista.
 * Idempotente: repetir reveal sobre una pista ya propia redevuelve el texto
 * (lo usa el menú si el móvil se reinició entre medias).
 */
export async function revealClue(
  gameId: string,
  playerId: string,
  clueId: string,
): Promise<ClueRevealPayload> {
  return db().runTransaction(async (tx: Transaction): Promise<ClueRevealPayload> => {
    const { found, clueRef } = await assertClaimableInTx(tx, gameId, playerId, clueId);

    const docSnap = await tx.get(clueRef);
    if (docSnap.exists) {
      const doc = docSnap.data() as ClueReservationDoc;
      if (doc.status === 'discovered') {
        if (doc.byPlayerId !== playerId) {
          throw httpError(
            409,
            'CLUE_UNAVAILABLE',
            'Esta pista ya ha sido descubierta por otro jugador.',
          );
        }
        return { clueId, name: found.clue.name, content: found.clue.content };
      }
      if (doc.byPlayerId !== playerId) {
        throw httpError(
          409,
          'CLUE_UNAVAILABLE',
          'Otro jugador está reservando esta pista en este momento.',
        );
      }
      if (!reservationIsFresh(doc)) {
        // La reserva propia expiró (p. ej. app cerrada sin confirmar): se
        // libera sola con el tiempo; el cliente debe volver a reservar.
        tx.delete(clueRef);
        throw httpError(
          409,
          'CLUE_UNAVAILABLE',
          'Tu reserva de esta pista ha expirado. Vuelve a intentarlo.',
        );
      }
    } else {
      // Sin reserva (claim perdido por red, expiración y limpieza, etc.).
      throw httpError(
        409,
        'CLUE_UNAVAILABLE',
        'No hay una reserva viva tuya sobre esta pista. Pídesela de nuevo.',
      );
    }

    const clue: ClueRevealPayload = {
      clueId,
      name: found.clue.name,
      content: found.clue.content,
    };

    // Sobrescritura completa: reservedAt desaparece con el nuevo documento.
    tx.set(clueRef, {
      status: 'discovered',
      byPlayerId: playerId,
      discoveredAt: FieldValue.serverTimestamp(),
    });
    return clue;
  });
}

/**
 * LIBERACIÓN de una reserva propia (paso opcional): si el jugador sale del
 * flujo antes de confirmar, la pista vuelve a estar libre para el resto.
 * Idempotente y conservadora: nunca toca un descubrimiento ya hecho ni la
 * reserva de otro jugador.
 */
export async function releaseClue(
  gameId: string,
  playerId: string,
  clueId: string,
): Promise<{ ok: boolean }> {
  await db().runTransaction(async (tx: Transaction) => {
    const clueRef = gameRefOf(gameId).collection('clues').doc(clueId);
    const docSnap = await tx.get(clueRef);
    if (!docSnap.exists) return;
    const doc = docSnap.data() as ClueReservationDoc;
    if (doc.status === 'reserved' && doc.byPlayerId === playerId) {
      tx.delete(clueRef);
    }
  });
  return { ok: true };
}

/**
 * ESTADO de la investigación PARA EL LLAMADOR: estados de las pistas de su
 * alcance (disponibles/reservadas/descubiertas), SUS pistas descubiertas (con
 * contenido, para el menú lateral) y SU cuaderno. Todo lo demás nunca viaja.
 */
export async function getInvestigationState(
  gameId: string,
  playerId: string,
): Promise<InvestigationStatePayload> {
  const gameRef = gameRefOf(gameId);
  const [mystery, clueDocsSnap, notebookSnap] = await Promise.all([
    loadValidatedMystery(gameId),
    gameRef.collection('clues').get(),
    gameRef.collection('notebooks').doc(playerId).get(),
  ]);

  // También es elegible lo que YA descubre por diseño (discoveredBy propio)
  // o "*": esas son las pistas que la UI le lista en cada habitación.
  const clueStates: MysteryClueStateView[] = [];
  const myDiscoveredClues: DiscoveredClueView[] = [];

  for (const room of mystery.rooms) {
    for (const clue of room.clues) {
      if (!isEligible(clue.discoveredBy, playerId)) continue;
      const doc = clueDocsSnap.docs.find((entry) => entry.id === clue.clueId);
      const data = doc?.data() as ClueReservationDoc | undefined;
      const status =
        data?.status === 'discovered' ? 'discovered'
        : data?.status === 'reserved' ? 'reserved'
        : 'available';
      const byPlayerId = doc?.exists && typeof data?.byPlayerId === 'string' ? data.byPlayerId : null;
      clueStates.push({ clueId: clue.clueId, roomId: room.roomId, status, byPlayerId });

      if (data?.status === 'discovered' && data.byPlayerId === playerId) {
        myDiscoveredClues.push({
          clueId: clue.clueId,
          name: clue.name,
          content: clue.content,
          discoveredAt: data.discoveredAt?.toDate?.().toISOString() ?? undefined,
        });
      }
    }
  }

  myDiscoveredClues.sort((a, b) => (a.discoveredAt ?? '').localeCompare(b.discoveredAt ?? ''));

  // Defensa en profundidad: aunque el doc solo se escribe por API con
  // validación, el resultado nunca incluye tipos grises.
  const notebook: NotebookView = {
    content:
      typeof notebookSnap.data()?.content === 'string'
        ? (notebookSnap.data() as { content: string }).content
        : '',
    updatedAt: notebookSnap.data()?.updatedAt?.toDate?.().toISOString() ?? null,
  };

  return { clueStates, myDiscoveredClues, notebook };
}

// ---------------------------------------------------------------------------
// CUADERNO PRIVADO: cada jugador escribe SU documento.
// ---------------------------------------------------------------------------

export async function getNotebook(gameId: string, playerId: string): Promise<NotebookView> {
  const snap = await gameRefOf(gameId).collection('notebooks').doc(playerId).get();
  const data = snap.data() as { content?: unknown; updatedAt?: Timestamp } | undefined;
  return {
    content: typeof data?.content === 'string' ? data.content : '',
    updatedAt: data?.updatedAt?.toDate?.().toISOString() ?? null,
  };
}

/**
 * Guarda el cuaderno del LLAMADOR (autoguardado del móvil). La validación de
 * tamaño ya la aplicó la ruta con el schema compartido; aquí se normaliza
 * (nunca más largo que el límite) y se sella el momento.
 */
export async function saveNotebook(
  gameId: string,
  playerId: string,
  input: NotebookUpdateInput,
): Promise<NotebookWritePayload> {
  if (input.content.length > NOTEBOOK_TEXT_MAX) {
    throw httpError(400, 'VALIDATION_ERROR', `El cuaderno no puede superar los ${NOTEBOOK_TEXT_MAX} caracteres`);
  }
  const gameRef = gameRefOf(gameId);
  const gameSnap = await gameRef.get();
  if (!gameSnap.exists) {
    throw httpError(404, 'GAME_NOT_FOUND', 'La partida ya no existe.');
  }
  await gameRef.collection('notebooks').doc(playerId).set({
    content: input.content,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
}
