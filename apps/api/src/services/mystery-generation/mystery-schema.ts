import { z } from 'zod';
import type { MysteryContext } from '@mystery/shared';

// ---------------------------------------------------------------------------
// ESQUEMA del JSON de salida del proveedor de IA (fn document = un misterio).
//
// Este archivo es el CONTRATO VALIDADO de la FASE 4:
//   · mysterySchema            → forma cruda que zod exige al payload
//     (debe coincidir con la estructura descrita en MYSTERY_SYSTEM_PROMPT:
//     los prompts le enseñan el formato al modelo y aquí lo verificamos;
//     cambiar un nombre de campo = cambiarlo en AMBOS sitios).
//   · validateMysteryPayload() → usa el esquema y añade las REGLAS CRUZADAS
//     que zod no puede saber solo: cada jugador del contexto aparece UNA
//     VEZ como personaje, un único asesino coherente con `solution`,
//     cómplice coherente (o null), y referencias de pistas válidas.
//
// Al validar con zod (safeParse) el resultado es una copia NORMALIZADA
// (parsed.data: sin campos extra que el modelo invente): esa copia es la
// que se almacenará en Firestore en la FASE 5.
//
// `validateMysteryPayload` NO depende del proveedor: mañana con otra IA
// (u otro formato de envoltura) la validación no cambia.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Esquema crudo. Los mínimos (min(1), min arrays) son el suelo: sin título,
// sin personajes, sin pistas o sin cronología el extraíble no es jugable.
// ---------------------------------------------------------------------------

export const mysterySchema = z.object({
  title: z.string().min(1),
  /** Introducción y ambientación. */
  setting: z.string().min(1),
  /** Resumen neutro de lo ocurrido (lo que sabe la policía al llegar). */
  synopsis: z.string().min(1),
  victim: z.object({
    name: z.string().min(1),
    /** Cómo, dónde y cuándo se encontró el cuerpo (la víctima lo sabe). */
    deathDetail: z.string().min(1),
  }),
  solution: z.object({
    murdererCharacterId: z.string().min(1),
    /** Cómplice opcional: null si la historia no lo necesita. */
    accompliceCharacterId: z.string().min(1).nullable(),
    motive: z.string().min(1),
    method: z.string().min(1),
    /** Reconstrucción cronológica completa + prueba que delata. */
    explanation: z.string().min(1),
  }),
  /** Personajes jugables: uno por jugador real del contexto; UNO de ellos es la víctima. */
  characters: z
    .array(
      z.object({
        characterId: z.string().min(1),
        /** playerId REAL del contexto (también la víctima, que es jugable). */
        playerId: z.string().min(1),
        name: z.string().min(1),
        /** Exactamente un personaje por partida: la víctima, que juega como cualquiera. */
        isVictim: z.boolean(),
        description: z.string().min(1),
        /** Lo que cualquiera puede saber de este personaje al empezar. */
        publicInfo: z.string().min(1),
        /** Lo que solo sabe este jugador (su parte privada del briefing). */
        privateInfo: z.string().min(1),
        /** Secreto que oculta: puede incriminarle sin ser el asesino. */
        secrets: z.string().min(1),
        objectives: z.array(z.string().min(1)).min(1),
        /**
         * Cronología INDIVIDUAL del personaje (FASE investigación): sus
         * momentos reales, lugares e interacciones; `publicClaim` es lo que
         * el personaje DECLARA (pueden mentir u ocultar, los hechos no).
         * `.default([])` mantiene legibles misterios generados antes de
         * este campo; la generación NUEVA exige entradas (regla cruzada 8).
         */
        personalTimeline: z
          .array(
            z.object({
              time: z.string().min(1),
              location: z.string().min(1),
              event: z.string().min(1),
              involvedCharacterIds: z.array(z.string()).default([]),
              publicClaim: z.string().min(1),
            }),
          )
          .default([]),
        isMurderer: z.boolean(),
        isAccomplice: z.boolean(),
      }),
    )
    .min(1),
  /** Testigos u otros personajes no jugables (puede venir vacío). */
  npcs: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().min(1),
      }),
    )
    .default([]),
  /** Habitaciones con sus pistas (al menos una localización jugable). */
  rooms: z
    .array(
      z.object({
        roomId: z.string().min(1),
        name: z.string().min(1),
        description: z.string().min(1),
        clues: z
          .array(
            z.object({
              clueId: z.string().min(1),
              name: z.string().min(1),
              /** Qué se ve y qué sugiere. */
              content: z.string().min(1),
              /** "*" = lo puede hallar cualquiera; o playerId = hallazgo privado. */
              discoveredBy: z.string().min(1),
              /** characterIds que conocen la pista desde el principio. */
              knownTo: z.array(z.string()).default([]),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  /** Cronología de la noche objetiva (no coincide con lo dicho por sospechosos). */
  timeline: z
    .array(
      z.object({
        time: z.string().min(1),
        event: z.string().min(1),
        /** Qué pueden llegar a saber los jugadores de este momento. */
        publicKnowledge: z.string().min(1),
      }),
    )
    .min(1),
  /** Texto final para revelar la solución al cierre de la partida. */
  resolution: z.string().min(1),
});

/** Tipo del misterio tras validar/normalizar (fields extra descartados). */
export type MysteryDocument = z.infer<typeof mysterySchema>;

// ---------------------------------------------------------------------------
// Reglas cruzadas + API de validación.
// ---------------------------------------------------------------------------

export interface MysteryValidationSuccess {
  ok: true;
  /** Copia normalizada lista para persistir en Firestore. */
  mystery: MysteryDocument;
}

export interface MysteryValidationFailure {
  ok: false;
  /** Razones legibles, una por línea, para lastGenerationError y logs. */
  issues: string[];
}

export type MysteryValidationResult = MysteryValidationSuccess | MysteryValidationFailure;

/** Resumen humano de los errores de zod: 'characters.2.playerId: …'. */
function summariseZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return `${path.length > 0 ? `${path}: ` : ''}${issue.message}`;
  });
}

/**
 * Duplicados en listas de identificadores: sin este chequeo pasarían
 * desapercibidos hasta estropear la partida.
 */
function countDuplicates(values: string[]): string[] {
  const seen = new Map<string, number>();
  for (const value of values) seen.set(value, (seen.get(value) ?? 0) + 1);
  return [...seen.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

/**
 * Valida el payload del proveedor CONTRA EL CONTEXTO REAL de la partida.
 * Devuelve una copia normalizada (ok + mystery) o las razones concretas del
 * rechazo: la FASE 5 usa este resultado para decidir ready vs generation_error.
 */
export function validateMysteryPayload(
  payload: unknown,
  context: MysteryContext,
): MysteryValidationResult {
  const parsed = mysterySchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, issues: summariseZodIssues(parsed.error) };
  }
  const mystery = parsed.data;
  const issues: string[] = [];

  // 1. Exactamente un personaje por jugador: sin omitir, duplicar o inventar.
  const expectedPlayerIds = new Set(context.players.map((player) => player.playerId));
  const usedPlayerIds = new Set(mystery.characters.map((character) => character.playerId));
  const missingPlayerIds = [...expectedPlayerIds].filter((id) => !usedPlayerIds.has(id));
  const unknownPlayerIds = [...usedPlayerIds].filter((id) => !expectedPlayerIds.has(id));
  const duplicatePlayerIds = countDuplicates(mystery.characters.map((c) => c.playerId));
  if (missingPlayerIds.length > 0) {
    issues.push(`characters no cubre los playerIds: ${missingPlayerIds.join(', ')}`);
  }
  if (unknownPlayerIds.length > 0) {
    issues.push(`characters usa playerIds desconocidos: ${unknownPlayerIds.join(', ')}`);
  }
  if (duplicatePlayerIds.length > 0) {
    issues.push(`characters repite playerIds: ${duplicatePlayerIds.join(', ')}`);
  }

  // 2. Exactlyamente una víctima, y SIEMPRE es un personaje jugable (playerId real).
  const victims = mystery.characters.filter((character) => character.isVictim);
  const victim = victims.length === 1 ? victims[0] : undefined;
  if (victim === undefined) {
    issues.push(`debe haber exactamente 1 isVictim=true (hay ${victims.length})`);
  }

  // 3. Un único asesino, marcado y coherente con solution; nunca es la víctima.
  const murderers = mystery.characters.filter((character) => character.isMurderer);
  const murderer = murderers.length === 1 ? murderers[0] : undefined;
  if (murderer === undefined) {
    issues.push(`debe haber exactamente 1 isMurderer=true (hay ${murderers.length})`);
  } else if (murderer.characterId !== mystery.solution.murdererCharacterId) {
    issues.push(
      `solution.murdererCharacterId (${mystery.solution.murdererCharacterId}) no coincide ` +
        `con el personaje isMurderer (${murderer.characterId})`,
    );
  }
  if (victim !== undefined && murderer !== undefined && victim.characterId === murderer.characterId) {
    issues.push('la víctima no puede ser el mismo personaje que el asesino');
  }

  // 4. Cómplice: coherente en el marcado y en la solution; nunca doble papel.
  const accomplices = mystery.characters.filter((character) => character.isAccomplice);
  const accomplice = accomplices.length === 1 ? accomplices[0] : undefined;
  const accompliceId = mystery.solution.accompliceCharacterId;
  if (mystery.solution.accompliceCharacterId === null) {
    if (accomplices.length > 0) {
      issues.push(
        'solution.accompliceCharacterId es null pero hay personajes con isAccomplice=true',
      );
    }
  } else {
    if (accomplice === undefined) {
      issues.push(
        `con accompliceCharacterId debe haber exactamente 1 isAccomplice=true (hay ${accomplices.length})`,
      );
    } else if (accomplice.characterId !== accompliceId) {
      issues.push(
        `solution.accompliceCharacterId (${accompliceId}) no coincide con el personaje ` +
          `isAccomplice (${accomplice.characterId})`,
      );
    }
    if (accompliceId === mystery.solution.murdererCharacterId) {
      issues.push('el cómplice no puede ser el mismo personaje que el asesino');
    }
    if (victim !== undefined && victim.characterId === accompliceId) {
      issues.push('la víctima no puede ser el mismo personaje que el cómplice');
    }
  }

  // 5. Identificadores únicos de personajes (solution y knownTo los citan).
  const characterIds = mystery.characters.map((character) => character.characterId);
  const duplicateCharacterIds = countDuplicates(characterIds);
  if (duplicateCharacterIds.length > 0) {
    issues.push(`characterIds duplicados: ${duplicateCharacterIds.join(', ')}`);
  }
  const knownCharacterIds = new Set(characterIds);

  // 6. Pistas direccionadas a jugadores reales; knownTo a personajes reales.
  for (const room of mystery.rooms) {
    for (const clue of room.clues) {
      if (clue.discoveredBy !== '*' && !expectedPlayerIds.has(clue.discoveredBy)) {
        issues.push(
          `pista ${clue.clueId} (${room.roomId}) discoveredBy debe ser "*" o un playerId real`,
        );
      }
      for (const knower of clue.knownTo) {
        if (!knownCharacterIds.has(knower)) {
          issues.push(`pista ${clue.clueId} (${room.roomId}) conocida por personaje inexistente: ${knower}`);
        }
      }
    }
  }

  // 7. Identificadores de habitaciones y pistas únicos: el roomId es citable
  //    en el resultado y el clueId es la CLAVE del documento de Firestore que
  //    garantiza que una pista se descubre UNA sola vez (duplicados romperían
  //    el candado de la transacción de investigación).
  const duplicateRoomIds = countDuplicates(mystery.rooms.map((room) => room.roomId));
  if (duplicateRoomIds.length > 0) {
    issues.push(`roomIds duplicados: ${duplicateRoomIds.join(', ')}`);
  }
  const duplicateClueIds = countDuplicates(
    mystery.rooms.flatMap((room) => room.clues.map((clue) => clue.clueId)),
  );
  if (duplicateClueIds.length > 0) {
    issues.push(`clueIds duplicados entre habitaciones: ${duplicateClueIds.join(', ')}`);
  }

  // 8. Cronologías individuales: la FASE de investigación y la pantalla de
  //    introducción las necesitan por personaje (nada de itinerarios vacíos),
  //    y sus interacciones citan personajes que existen.
  for (const character of mystery.characters) {
    if (character.personalTimeline.length === 0) {
      issues.push(
        `el personaje ${character.characterId} (${character.name}) no tiene personalTimeline: ` +
          'cada personaje necesita su cronología individual con al menos 1 momento',
      );
    }
    for (const point of character.personalTimeline) {
      for (const involved of point.involvedCharacterIds) {
        if (!knownCharacterIds.has(involved)) {
          issues.push(
            `personalTimeline de ${character.characterId} cita un personaje inexistente: ${involved}`,
          );
        }
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, mystery };
}
