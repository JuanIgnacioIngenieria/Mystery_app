import { describe, expect, it } from 'vitest';
import { validateMysteryPayload, type MysteryDocument, type MysteryValidationResult } from '../src/services/mystery-generation/mystery-schema.js';
import type { MysteryContext } from '@mystery/shared';

// ---------------------------------------------------------------------------
// Tests del esquema del misterio (FASE 4): forma cruda + reglas cruzadas.
// Solo lógica pura: nada de Firestore ni proveedor de IA.
// ---------------------------------------------------------------------------

const CONTEXT: MysteryContext = {
  gameId: 'game-1',
  gameCode: 'ABC12',
  hostId: 'player-a',
  participantCount: 3,
  players: [
    { playerId: 'player-a', username: 'Ana', isHost: true, profile: {} as never, specialRelationships: [], relationships: [] },
    { playerId: 'player-b', username: 'Bruno', isHost: false, profile: {} as never, specialRelationships: [], relationships: [] },
    { playerId: 'player-c', username: 'Carla', isHost: false, profile: {} as never, specialRelationships: [], relationships: [] },
  ],
};

/** Espera validación correcta y devuelve el misterio (narrows el tipo). */
function expectOkMystery(result: MysteryValidationResult): MysteryDocument {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`esperaba validación correcta: ${result.issues.join('\n')}`);
  return result.mystery;
}

/** Espera fallo y devuelve las razones legibles (narrows el tipo). */
function failureIssues(result: MysteryValidationResult): string[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('esperaba fallo de validación');
  return result.issues;
}

/** Misterio de ejemplo que cumple TODO el esquema para el contexto anterior. */
function validMystery() {
  return {
    title: 'La bodega de las viñas muertas',
    setting: 'Un aniversario de vendimia en una casa rural de La Rioja, 2026.',
    synopsis: 'El dueño de la bodega aparece muerto en la sala de barricas.',
    victim: {
      name: 'Miguel Sánchez',
      description: 'Rey de la vendimia local, dueño de la bodega desde hace décadas.',
      deathDetail: 'Encontrado de madrugada entre las barricas, con signos de envenenamiento.',
    },
    solution: {
      murdererCharacterId: 'char-2',
      accompliceCharacterId: null,
      motive: 'Heredar la bodega',
      method: 'Envenenamiento con azufre',
      explanation: 'Reconstrucción completa del crimen.',
    },
    characters: [
      {
        characterId: 'char-1',
        playerId: 'player-a',
        name: 'Elvira Herrero',
        isVictim: false,
        description: 'Enóloga veterana.',
        publicInfo: 'Responsable de la sala de barricas.',
        privateInfo: 'Sabe que el dueño iba a vender la bodega.',
        secrets: 'Debe dinero a la víctima.',
        objectives: ['Descubrir quién falsificó el inventario.'],
        isMurderer: false,
        isAccomplice: false,
      },
      {
        characterId: 'char-2',
        playerId: 'player-b',
        name: 'Sergio Ruiz',
        isVictim: false,
        description: 'Sobrino del dueño y heredero.',
        publicInfo: 'Llegó el último a la casa.',
        privateInfo: 'Telefona en secreto con un comprador de la finca.',
        secrets: 'Falsificó el testamento.',
        objectives: ['Que nadie descubra el testamento falsificado.'],
        isMurderer: true,
        isAccomplice: false,
      },
      {
        characterId: 'char-3',
        playerId: 'player-c',
        name: 'Laura Nieto',
        isVictim: true,
        description: 'Amiga de la familia y pareja del difunto en el pasado.',
        publicInfo: 'Organizó la vendimia.',
        privateInfo: 'Murió envenenada en la sala de barricas: quiere saber quién lo hizo.',
        secrets: 'Sabía que el difunto iba a cambiar el testamento.',
        objectives: ['Descubrir quién la envenenó.'],
        isMurderer: false,
        isAccomplice: false,
      },
    ],
    npcs: [{ name: 'Policía local Herrera', description: 'Investiga y toma declaraciones.' }],
    rooms: [
      {
        roomId: 'room-1',
        name: 'Sala de barricas',
        description: 'Húmeda y oscura, huele a roble y azufre.',
        clues: [
          {
            clueId: 'clue-1',
            name: 'Botella de azufre abierta',
            content: 'El tapón está suelto y hay huellas.',
            discoveredBy: '*',
            knownTo: [],
          },
        ],
      },
    ],
    timeline: [
      {
        time: '23:30',
        event: 'La víctima baja a la bodega.',
        publicKnowledge: 'Todos la vieron irse temprano.',
      },
    ],
    resolution: 'Sergio Ruiz asesinó a la víctima para heredar la bodega.',
  };
}

/** Clona el misterio válido sin compartir referencias (mutaciones seguras). */
function clone(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data));
}

describe('validateMysteryPayload · esquema crudo', () => {
  it('acepta un misterio completo y devuelve la copia normalizada', () => {
    const mystery = expectOkMystery(validateMysteryPayload(validMystery(), CONTEXT));
    // La copia normalizada solo contiene campos declarados en el esquema.
    expect(mystery.characters).toHaveLength(3);
    expect(mystery.rooms).toHaveLength(1);
    expect(mystery.rooms[0]?.roomId).toBe('room-1');
  });

  it('tolera `npcs` ausente (aplicando el default del esquema)', () => {
    const payload = clone(validMystery());
    (payload as Record<string, unknown>).npcs = undefined;
    const mystery = expectOkMystery(validateMysteryPayload(payload, CONTEXT));
    expect(mystery.npcs).toHaveLength(0);
  });

  it('tolera `knownTo` ausente en las pistas (default [])', () => {
    const payload = clone(validMystery()) as { rooms: Array<{ clues: Array<Record<string, unknown>> }> };
    delete payload.rooms[0]!.clues[0]!.knownTo;
    const mystery = expectOkMystery(validateMysteryPayload(payload, CONTEXT));
    expect(mystery.rooms[0]?.clues[0]?.knownTo).toHaveLength(0);
  });

  it('rechaza payload que no es objeto', () => {
    const issues = failureIssues(validateMysteryPayload('no soy un misterio', CONTEXT));
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rechaza payload con campos obligatorios vacíos', () => {
    const payload = clone(validMystery()) as Record<string, unknown>;
    payload.title = '';
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('title');
  });

  it('descarta los campos extra no declarados en el esquema', () => {
    const payload = clone(validMystery()) as Record<string, unknown>;
    payload.campoSobrante = 'inventado por el modelo';
    const mystery = expectOkMystery(validateMysteryPayload(payload, CONTEXT));
    expect((mystery as unknown as Record<string, unknown>).campoSobrante).toBeUndefined();
  });
});

describe('validateMysteryPayload · reglas cruzadas contra el contexto', () => {
  it('detecta un playerId del contexto sin personaje', () => {
    const payload = clone(validMystery()) as { characters: Array<{ playerId: string }> };
    payload.characters = payload.characters.filter((c) => c.playerId !== 'player-c');
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('player-c');
  });

  it('detecta un playerId inventado que no juega la partida', () => {
    const payload = clone(validMystery()) as { characters: Array<{ playerId: string }> };
    payload.characters[0]!.playerId = 'player-z';
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('player-z');
  });

  it('detecta un playerId repetido entre personajes', () => {
    const payload = clone(validMystery()) as { characters: Array<{ playerId: string }> };
    payload.characters[1]!.playerId = 'player-a';
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('repite playerIds');
  });

  it('rechaza dos asesinos', () => {
    const payload = clone(validMystery()) as {
      characters: Array<{ isMurderer: boolean }>;
      solution: { murdererCharacterId: string };
    };
    payload.characters[2]!.isMurderer = true;
    payload.solution.murdererCharacterId = 'char-3';
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('exactamente 1 isMurderer');
  });

  it('rechaza asesino marcado distinto al de solution', () => {
    const payload = clone(validMystery()) as { solution: { murdererCharacterId: string } };
    payload.solution.murdererCharacterId = 'char-1';
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('murdererCharacterId');
  });

  it('rechaza marca de cómplice sin solution.accompliceCharacterId coherente', () => {
    const payload = clone(validMystery()) as {
      characters: Array<{ isAccomplice: boolean }>;
      solution: { accompliceCharacterId: string | null };
    };
    payload.characters[2]!.isAccomplice = true;
    payload.solution.accompliceCharacterId = null;
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('isAccomplice');
  });

  it('rechaza discoveredBy que no es "*" ni un playerId real', () => {
    const payload = clone(validMystery()) as {
      rooms: Array<{ clues: Array<{ discoveredBy: string }> }>;
    };
    payload.rooms[0]!.clues[0]!.discoveredBy = 'player-z';
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('discoveredBy');
  });

  it('acepta discoveredBy = "*" (pista pública)', () => {
    expectOkMystery(validateMysteryPayload(validMystery(), CONTEXT));
  });

  it('rechaza knownTo que cita un personaje inexistente', () => {
    const payload = clone(validMystery()) as {
      rooms: Array<{ clues: Array<{ knownTo: string[] }> }>;
    };
    payload.rooms[0]!.clues[0]!.knownTo = ['char-99'];
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('char-99');
  });
});

describe('validateMysteryPayload · víctima jugable (nuevo diseño)', () => {
  it('acepta con exactamente una víctima entre los personajes', () => {
    expectOkMystery(validateMysteryPayload(validMystery(), CONTEXT));
  });

  it('rechaza una partida sin víctima', () => {
    const payload = clone(validMystery()) as { characters: Array<{ isVictim?: boolean }> };
    for (const character of payload.characters) character.isVictim = false;
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('isVictim');
  });

  it('rechaza dos víctimas', () => {
    const payload = clone(validMystery()) as { characters: Array<{ isVictim: boolean }> };
    payload.characters[0]!.isVictim = true;
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('exactamente 1 isVictim');
  });

  it('rechaza que la víctima sea la asesina', () => {
    const payload = clone(validMystery()) as {
      characters: Array<{ characterId: string; isMurderer: boolean }>;
      solution: { murdererCharacterId: string };
    };
    // Quita el asesino original y convierte a la víctima en asesino: el único
    // "pero" que debe saltar es el choque víctima↔asesina.
    payload.characters[1]!.isMurderer = false;
    payload.characters[2]!.isMurderer = true;
    payload.solution.murdererCharacterId = 'char-3';
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('la víctima no puede ser el mismo personaje que el asesino');
  });

  it('rechaza que la víctima sea la cómplice', () => {
    const payload = clone(validMystery()) as {
      characters: Array<{ characterId: string; isAccomplice: boolean }>;
      solution: { accompliceCharacterId: string | null };
    };
    payload.characters[2]!.isAccomplice = true;
    payload.solution.accompliceCharacterId = 'char-3';
    const issues = failureIssues(validateMysteryPayload(payload, CONTEXT));
    expect(issues.join('\n')).toContain('la víctima no puede ser el mismo personaje que el cómplice');
  });
});
