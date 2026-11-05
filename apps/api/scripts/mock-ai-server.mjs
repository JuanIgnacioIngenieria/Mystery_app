/**
 * MOCK del proveedor de IA para probar el servicio de generación.
 *
 * · Recibe el POST del backend (body: { mysteryContext }) y lo guarda en
 *   memoria; GET /__last devuelve lo último recibido (para verificar el
 *   JSON exacto que el backend envió).
 * · Responde 200 con un MYSTERIO COMPLETO Y VÁLIDO según mystery-schema.ts
 *   (una víctima jugable, un asesino distinto, pistas, cronología...), así
 *   el backend lo valida, lo almacena y marca 'ready' — todo el camino
 *   feliz sin gastar saldo del proveedor real.
 * · Si el body no lleva mysteryContext responde 400: también se puede
 *   probar el camino de error (GENERATION_HTTP_ERROR → 'generation_error').
 *
 * Uso:  node scripts/mock-ai-server.mjs      (puerto MOCK_AI_PORT, 4010)
 *
 * Es una utilidad de pruebas: NO forma parte de la API ni la app móvil.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_AI_PORT ?? 4010);
let lastRequest = null;

/** Misterio completo coherente con el contexto: pasa validateMysteryPayload. */
function buildMystery(context) {
  const victimIndex = 0;
  const murdererIndex = context.players.length - 1;
  const victim = context.players[victimIndex];
  const murderer = context.players[murdererIndex];

  const characters = context.players.map((player, index) => ({
    characterId: `char-${index + 1}`,
    playerId: player.playerId,
    name: player.username,
    isVictim: index === victimIndex,
    description: `${player.username} (mock): ${player.profile.description ?? 'perfil no disponible'}`,
    publicInfo: `Información pública de ${player.username} (mock).`,
    privateInfo: `Información privada de ${player.username} (mock).`,
    secrets: `Secreto de ${player.username} (mock).`,
    objectives:
      index === victimIndex
        ? ['Descubrir quién te envenenó (mock).']
        : [`Sobrevivir a la noche de ${context.gameCode} (mock).`],
    isMurderer: index === murdererIndex,
    isAccomplice: false,
  }));

  return {
    title: `La partida ${context.gameCode} ha salido mal (mock)`,
    setting: 'Mock: aniversario en una finca rural donde reaparecen viejos vínculos.',
    synopsis: "Mock: el cuerpo aparece de madrugada en el salón y la policía tarda dos horas.",
    victim: {
      name: victim.username,
      deathDetail: 'Mock: encontrado en el salón a las 00:30, sin signos de lucha.',
    },
    solution: {
      murdererCharacterId: characters[murdererIndex].characterId,
      accompliceCharacterId: null,
      motive: 'Mock: ocultar una deuda antigua.',
      method: 'Mock: veneno en la última copa.',
      explanation: 'Mock: reconstrucción cronológica completa del crimen de ejemplo.',
    },
    characters,
    npcs: [{ name: 'Policía local (mock)', description: 'Levanta acta y toma declaraciones.' }],
    rooms: [
      {
        roomId: 'room-1',
        name: 'Salón (mock)',
        description: 'Amplio, con la copa de la víctima en la mesa.',
        clues: [
          {
            clueId: 'clue-1',
            name: 'Copa de vino (mock)',
            content: 'Restos de sedimento junto a la copa: sugiere la última copa.',
            discoveredBy: '*',
            knownTo: [],
          },
          {
            clueId: 'clue-2',
            name: 'Nota arrugada (mock)',
            content: 'Una nota con una cifra y las iniciales de la víctima.',
            discoveredBy: characters[context.players.length - 1]?.playerId ?? '*',
            knownTo: [],
          },
        ],
      },
      {
        roomId: 'room-2',
        name: 'Cocina (mock)',
        description: 'Desordenada: hay una botella medio vacía.',
        clues: [
          {
            clueId: 'clue-3',
            name: 'Botella con aria (mock)',
            content: 'La botella no corresponde a la bebida servida en el salón.',
            discoveredBy: '*',
            knownTo: [characters[murdererIndex]?.characterId ?? 'char-1'],
          },
        ],
      },
    ],
    timeline: [
      {
        time: '23:45',
        event: 'Mock: se sirve la última ronda en el salón.',
        publicKnowledge: 'Mock: todos vieron la ronda final.',
      },
      {
        time: '00:30',
        event: 'Mock: alguien encuentra el cuerpo.',
        publicKnowledge: 'Mock: a partir de aquí nadie sale de la finca.',
      },
    ],
    resolution: 'Mock: al final de la partida se revela al asesino y su método.',
  };
}

const server = createServer((req, res) => {
  const isPostMystery = req.method === 'POST' && (req.url === '/mystery' || req.url === '/');

  if (isPostMystery) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const context = parsed?.mysteryContext;
      lastRequest = {
        receivedAt: new Date().toISOString(),
        headers: { authorization: req.headers.authorization ?? null },
        body: parsed,
      };

      if (!context || typeof context !== 'object' || !Array.isArray(context.players)) {
        console.log('[mock-ai] POST sin mysteryContext válido → 400');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Falta mysteryContext en el body.' }));
        return;
      }

      console.log(
        `[mock-ai] POST recibido ✓ partida=${context.gameId} host=${context.hostId} ` +
          `jugadores=${context.players.length} ` +
          `(Bearer: ${lastRequest.headers.authorization ? 'sí' : 'no'})`,
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildMystery(context)));
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/__last') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lastRequest));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Mock de IA: usa POST /mystery o GET /__last');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-ai] escuchando en http://127.0.0.1:${PORT}/mystery`);
});
