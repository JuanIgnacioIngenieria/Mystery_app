import type {
  MysteryContext,
  MysteryPlayerContext,
  MysteryRelationship,
  MysterySpecialRelationship,
} from '@mystery/shared';
import type { DocumentData } from 'firebase-admin/firestore';
import type { GameDoc, PlayerDoc } from '../../services/games.service.js';
import { MysteryGenerationError } from './contract.js';

/**
 * Construye el contexto COMPLETO del misterio a partir de la copia CONSISTENTE
 * de datos leída en la transacción de inicio (nunca releyendo después: los
 * joins/ediciones posteriores no pueden contaminar una generación en curso).
 *
 * Reglas:
 *  - No se inventa contenido: los perfiles llegan verificados por la
 *    completitud del inicio; si algo falta, se falla con razón concreta.
 *  - Identificadores ESTABLES (Firestore IDs) para relacionar participantes.
 *  - Estructura deliberadamente ampliable: los futuros parámetros de
 *    generación (estilo, tono, duración…) entrarán al nivel raíz o por
 *    jugador sin romper el contrato ya publicado.
 */

/**
 * Snapshots genéricos (admin devuelve DocumentData solo-lectura). `data()`
 * admite undefined porque los snapshots de documento (a diferencia de los de
 * query) pueden apuntar a docs inexistentes; el llamador ya los ha filtrado
 * (startGame comprueba `exists` antes de construir el contexto).
 */
export interface SnapshotGame {
  id: string;
  data(): DocumentData | undefined;
}

export interface SnapshotPlayer {
  id: string;
  data(): DocumentData | undefined;
}

function sanitizeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function buildPlayerContext(
  player: SnapshotPlayer,
  validTargetIds: ReadonlySet<string>,
): MysteryPlayerContext {
  const data = player.data() as PlayerDoc;
  const profile = data.profile ?? {
    aboutMe: '',
    job: '',
    clothing: '',
    hobbies: '',
    drinks: '',
    fears: '',
  };
  const relations = data.relations ?? {};

  const specialRelationships: MysterySpecialRelationship[] = [];
  const relationships: MysteryRelationship[] = [];
  for (const [targetPlayerId, relation] of Object.entries(relations)) {
    // Relación hacia alguien que ya no está en el snapshot (salida durante
    // el arranque): se descarta. El contexto nunca referencia a jugadores
    // ausentes: los identificadores deben ser resolvibles por el proveedor.
    if (!validTargetIds.has(targetPlayerId)) continue;
    // Solo entradas con contenido: la valoración siempre existe (0-10), la
    // descripción solo entra si el jugador la redactó (relación especial).
    relationships.push({ targetPlayerId, level: relation.level });
    if (relation.description.length > 0) {
      specialRelationships.push({ targetPlayerId, description: relation.description });
    }
  }

  return {
    playerId: player.id,
    username: sanitizeText(data.displayName),
    isHost: data.isHost === true,
    profile: {
      description: sanitizeText(profile.aboutMe),
      occupation: sanitizeText(profile.job),
      clothing: sanitizeText(profile.clothing),
      habitsAndHobbies: sanitizeText(profile.hobbies),
      drinks: sanitizeText(profile.drinks),
      fears: sanitizeText(profile.fears),
    },
    specialRelationships,
    relationships,
  };
}

/**
 * Último control de integridad antes de construir el contexto: aunque la
 * transacción de inicio ya validó completitud, aquí se re-comprueba campo a
 * campo (defensa en profundidad). Si falta algo, el misterio no se fabrica
 * con huecos.
 */
export function buildMysteryContext(
  game: SnapshotGame,
  players: SnapshotPlayer[],
): MysteryContext {
  const gameData = game.data() as GameDoc;
  const hostId = sanitizeText(gameData.hostPlayerId);
  if (hostId.length === 0) {
    throw new MysteryGenerationError('GENERATION_INTERNAL', 'La partida no tiene anfitrión registrado.');
  }

  if (players.length < gameData.playerCount) {
    // Alguna baja entre la transacción y aquí: consistency threat real.
    throw new MysteryGenerationError(
      'GENERATION_INTERNAL',
      'La lista de participantes cambió durante el arranque: contexto inconsistente.',
    );
  }

  // Conjunto cerrado de participantes del snapshot: las relaciones apuntan
  // solo a jugadores presentes (identificadores estables y resolvibles).
  const validTargetIds = new Set(players.map((player) => player.id));

  const playerContexts: MysteryPlayerContext[] = players.map((player) => {
    const context = buildPlayerContext(player, validTargetIds);
    const { profile } = context;
    const missingFields = Object.entries(profile)
      .filter(([, value]) => value.length === 0)
      .map(([field]) => field);
    if (missingFields.length > 0) {
      throw new MysteryGenerationError(
        'GENERATION_CONTEXT_INCOMPLETE',
        `El perfil de ${context.username || 'un jugador'} tiene campos vacíos (${missingFields.join(', ')}).`,
      );
    }
    return context;
  });

  return {
    gameId: game.id,
    gameCode: sanitizeText(gameData.code),
    hostId,
    participantCount: players.length,
    players: playerContexts,
  };
}
