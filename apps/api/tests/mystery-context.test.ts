import { describe, expect, it } from 'vitest';
import { buildMysteryContext } from '../src/services/mystery-generation/context.js';
import { MysteryGenerationError } from '../src/services/mystery-generation/contract.js';

// ---------------------------------------------------------------------------
// Tests del contexto del misterio (§ construcción del JSON en el backend).
// Son lógica pura: los snapshots falsos cumplen las interfaces
// SnapshotGame/SnapshotPlayer, así no hace falta Firestore aquí.
// ---------------------------------------------------------------------------

/** Snapshot falso de partida, compatible con SnapshotGame. */
function fakeGame(data: Record<string, unknown>, id = 'game-1') {
  return { id, data: () => data };
}

/** Snapshot falso de jugador, compatible con SnapshotPlayer. */
function fakePlayer(id: string, data: Record<string, unknown>) {
  return { id, data: () => data };
}

const FULL_PROFILE = {
  aboutMe: 'Curioso, observador y algo sarcástico',
  job: 'Programador de turnos de noche',
  clothing: 'Sudadera gris y zapatillas viejas',
  hobbies: 'Ajedrez, senderismo y true crime',
  drinks: 'Gin tónica y café con hielo',
  fears: 'Quedarme solo en el bosque',
};

function playerData(displayName: string, extra: Record<string, unknown> = {}) {
  return {
    displayName,
    isHost: false,
    profile: { ...FULL_PROFILE },
    relations: {},
    ...extra,
  };
}

describe('buildMysteryContext', () => {
  const baseGame = { code: 'ABCDE', hostPlayerId: 'host-1', playerCount: 3 };

  function threePlayers() {
    return [
      fakePlayer('host-1', playerData('Laura', { isHost: true })),
      fakePlayer('p2', playerData('Marcos', {
        relations: {
          'host-1': { level: 9, description: 'Amigos desde pequeños' },
          p3: { level: 4, description: '' },
        },
      })),
      fakePlayer('p3', playerData('Irene', {
        relations: {
          'host-1': { level: 7, description: 'Compañeras de piso' },
          p2: { level: 6, description: '' },
        },
      })),
    ];
  }

  it('construye el JSON completo del contexto con identificadores estables', () => {
    const context = buildMysteryContext(fakeGame(baseGame), threePlayers());

    expect(context.gameId).toBe('game-1');
    expect(context.gameCode).toBe('ABCDE');
    expect(context.hostId).toBe('host-1');
    expect(context.participantCount).toBe(3);
    expect(context.players).toHaveLength(3);

    const marcos = context.players.find((player) => player.playerId === 'p2')!;
    expect(marcos.username).toBe('Marcos');
    expect(marcos.isHost).toBe(false);
    expect(marcos.profile).toEqual({
      description: FULL_PROFILE.aboutMe,
      occupation: FULL_PROFILE.job,
      clothing: FULL_PROFILE.clothing,
      habitsAndHobbies: FULL_PROFILE.hobbies,
      drinks: FULL_PROFILE.drinks,
      fears: FULL_PROFILE.fears,
    });
    expect(marcos.relationships).toEqual([
      { targetPlayerId: 'host-1', level: 9 },
      { targetPlayerId: 'p3', level: 4 },
    ]);
    // Solo la descripción redactada es "relación especial"; la vacía no entra.
    expect(marcos.specialRelationships).toEqual([
      { targetPlayerId: 'host-1', description: 'Amigos desde pequeños' },
    ]);
  });

  it('descarta relaciones hacia jugadores que ya no están en el snapshot', () => {
    const players = [
      fakePlayer('host-1', playerData('Laura', { isHost: true })),
      fakePlayer('p2', playerData('Marcos', {
        relations: { fantasma: { level: 8, description: 'Ya no está en la partida' } },
      })),
      fakePlayer('p3', playerData('Irene')),
    ];
    const context = buildMysteryContext(fakeGame(baseGame), players);
    const marcos = context.players.find((player) => player.playerId === 'p2')!;
    expect(marcos.relationships).toEqual([]);
    expect(marcos.specialRelationships).toEqual([]);
  });

  it('falla si algún perfil tiene campos vacíos (nunca se fabrica con huecos)', () => {
    const players = [
      fakePlayer('host-1', playerData('Laura', { isHost: true })),
      fakePlayer('p2', playerData('Marcos', { profile: { ...FULL_PROFILE, fears: '' } })),
      fakePlayer('p3', playerData('Irene')),
    ];
    expect(() => buildMysteryContext(fakeGame(baseGame), players)).toThrow(MysteryGenerationError);
    expect(() => buildMysteryContext(fakeGame(baseGame), players)).toThrow(/fears/);
  });

  it('falla si la partida no tiene anfitrión registrado', () => {
    expect(() =>
      buildMysteryContext(fakeGame({ ...baseGame, hostPlayerId: '' }), threePlayers()),
    ).toThrow(MysteryGenerationError);
  });

  it('falla si el snapshot de jugadores no cubre el recuento de la partida', () => {
    expect(() =>
      buildMysteryContext(fakeGame(baseGame), threePlayers().slice(0, 2)),
    ).toThrow(/contexto inconsistente/i);
  });
});
