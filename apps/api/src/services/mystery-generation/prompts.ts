import type { MysteryContext } from '@mystery/shared';

// ---------------------------------------------------------------------------
// PROMPTS de generación del misterio (solo backend; nunca viajan al móvil).
//
// Separación System/User:
//   · System Prompt → rol del modelo (Game Master), reglas de diseño del
//     juego y la especificación del JSON de salida con un ejemplo.
//   · User Prompt   → contexto REAL de la partida (mysteryContext) + los
//     requisitos que dependen del número de jugadores concreto.
//
// Requisito oficial del JSON Output de DeepSeek: la palabra «json» y un
// ejemplo del formato deseado deben aparecer en el prompt (están aquí).
//
// ⚠️ SINCRONIZACIÓN: la estructura descrita en MYSTERY_SYSTEM_PROMPT debe
// coincidir con el esquema zod de mystery-schema.ts (FASE 4): los nombres de
// campo son el contrato que valida la FASE 5. Cámbialos en ambos sitios.
// ---------------------------------------------------------------------------

/** Rol + reglas de juego + especificación de la salida json. */
export const MYSTERY_SYSTEM_PROMPT = [
  'Eres un Game Master experto en misterios de asesinato para jugar en grupo (murder mystery party).',
  'Tu trabajo es diseñar una partida completa, coherente y resoluble a partir del contexto json de jugadores que recibirás.',
  '',
  'REGLAS DE DISEÑO OBLIGATORIAS:',
  '1. Cada jugador real interpreta EXACTAMENTE un personaje jugable; usa su perfil y sus relaciones reales para personalizarlo (ocupación, aficiones, miedos y vínculos).',
  '2. SIEMPRE hay exactamente UNA víctima y ES uno de los personajes jugables: su personaje lleva isVictim=true, un playerId real y juega como cualquiera.',
  '3. La víctima sabe que murió (se le explica cómo y dónde se encontró su cuerpo), pero NO sabe quién la mató, ni cómo ni por qué: juega como un jugador cualquiera y puede descubrir pistas igual que los demás.',
  '4. Uno de los personajes que NO sea la víctima es el asesino (isMurderer=true), y él sí conoce su crimen (su información privada incluye su culpa y su plan). El cómplice es opcional (null si no lo hay).',
  '5. Todos los demás personajes (víctima incluida) son inocentes pero sospechosos: cada uno tiene algo que ocultar (secretos), incentivos para mentir y una coartada verificable o falsificable. Los objetivos de la víctima giran alrededor de descubrir quién la mató.',
  '6. El caso debe ser RESOLUBLE: la unión de las pistas de las habitaciones, la cronología y los secretos debe permitir deducir quién es el asesino, con qué método y por qué (motivo).',
  '7. Usa las relaciones reales (niveles 0-10) y las relaciones especiales (descripciones escritas por los jugadores) para crear tensiones creíbles: celos, deudas, reencuentros, rivalidades.',
  '8. Respeta el mundo propuesto por el contexto: el misterio ocurre en un enclave que encaje con los perfiles (p. ej. una casa rural, un crucero, una finca) y los personajes deben poder cruzarse en su vida real.',
  '9. Todo redactado en español de España, tono cinematográfico y sobrio, sin violencia gratuita.',
  '10. El asesino y el cómplice son SIEMPRE personajes distintos de la víctima: la víctima no puede ser asesina ni cómplice.',
  '',
  'FORMATO DE SALIDA OBLIGATORIO: responde ÚNICAMENTE con un objeto json (sin markdown, sin texto fuera del json) con esta estructura exacta:',
  `{`,
  `  "title": "título del misterio",`,
  `  "setting": "introducción y ambientación (2-4 frases: dónde, cuándo y por qué están juntos)",`,
  `  "synopsis": "resumen neutro de lo ocurrido tal como lo sabe la policía al llegar",`,
  `  "victim": {`,
  `    "name": "nombre completo de la víctima",`,
  `    "deathDetail": "cómo, dónde y cuándo se encontró el cuerpo"`,
  `  },`,
  `  "solution": {`,
  `    "murdererCharacterId": "characterId del asesino",`,
  `    "accompliceCharacterId": "characterId del cómplice, o null",`,
  `    "motive": "motivo real del asesinato",`,
  `    "method": "cómo se cometió el crimen",`,
  `    "explanation": "reconstrucción cronológica completa del crimen con las pruebas que lo delatan"`,
  `  },`,
  `  "characters": [`,
  `    {`,
  `      "characterId": "char-1, char-2, ...",`,
  `      "playerId": "el playerId REAL del contexto (uno por jugador, sin repetir ni omitir; la víctima TAMBIÉN lleva playerId)",`,
  `      "name": "nombre del personaje",`,
  `      "isVictim": "true en EXACTAMENTE un personaje (la víctima jugable); false en el resto",`,
  `      "description": "personalidad, antecedentes e historia del personaje",`,
  `      "publicInfo": "lo que cualquiera puede saber de este personaje al empezar",`,
  `      "privateInfo": "información que solo conoce este jugador (guárdala también en playerBriefing)",`,
  `      "secrets": "el secreto que oculta (puede delatarle o incriminarle sin ser el asesino)",`,
  `      "objectives": ["objetivos concretos que debe lograr durante la partida"],`,
  `      "isMurderer": false,`,
  `      "isAccomplice": false`,
  `    }`,
  `  ],`,
  `  "npcs": [ { "name": "nombre", "description": "testigos u otros personajes no jugables relevantes (los personajes de jugadores NUNCA van aquí, ahí está la víctima)" } ],`,
  `  "rooms": [`,
  `    {`,
  `      "roomId": "room-1, room-2, ...",`,
  `      "name": "nombre de la habitación o locación",`,
  `      "description": "cómo es y qué ambiente tiene",`,
  `      "clues": [`,
  `        {`,
  `          "clueId": "clue-1, clue-2, ...",`,
  `          "name": "objeto o pista",`,
  `          "content": "qué se ve y qué sugiere",`,
  `          "discoveredBy": "\\"*\\" (lo puede encontrar cualquiera) o el playerId concreto que lo halla",`,
  `          "knownTo": "lista de characterId que conocen esta pista desde el principio, o [] si es sorpresa"`,
  `        }`,
  `      ]`,
  `    }`,
  `  ],`,
  `  "timeline": [ { "time": "hh:mm", "event": "qué ocurrió", "publicKnowledge": "qué pueden llegar a saber los jugadores de este momento" } ],`,
  `  "resolution": "texto final que revela la solución completa al terminar la partida"`,
  `}`,
].join('\n');

/**
 * Prompt del usuario: contexto real de la partida + requisitos que dependen
 * de su tamaño. El contexto va serializado (json) tal y como lo construyó
 * buildMysteryContext (snapshot almacenado en games/{id}.mysteryContext).
 */
export function buildMysteryUserPrompt(context: MysteryContext): string {
  const playerIds = context.players.map((player) => player.playerId);
  return [
    'Diseña el misterio para esta partida real. CONTEXTO de la partida en formato json:',
    JSON.stringify(context, null, 2),
    '',
    'Requisitos de esta partida concreta:',
    `- Hay ${context.players.length} jugadores (participantCount=${context.participantCount}): crea EXACTAMENTE ${context.players.length} personajes jugables y asigna cada playerId UNA SOLA VEZ, usando estos playerIds: ${playerIds.join(', ')}.`,
    '- Ningún playerId puede faltar, repetirse o inventarse.',
    '- EXACTAMENTE uno de esos personajes es la víctima (isVictim=true): juega como cualquiera y NO debe tener isMurderer ni isAccomplice; el asesino y el cómplice, si existe, son otros personajes.',
    `- El anfitrión es el jugador con playerId ${context.hostId}: dale un personaje central pero NO lo conviertas por defecto en asesino.`,
    '- Teje las historias con sus relaciones y relaciones especiales tal cual vienen del contexto.',
    '- Parte la información estratégicamente: pistas en distintas habitaciones y secretos repartidos para que todos tengan algo que aportar.',
    '',
    'Devuelve ÚNICAMENTE el objeto json con la estructura descrita en tus instrucciones de sistema.',
  ].join('\n');
}
