/**
 * SMOKE TEST E2E del servicio de generación del misterio (sin proveedor real).
 *
 * Recorre el flujo completo contra el backend REAL y el Firebase REAL:
 *   1. health → credenciales ok.
 *   2. Crear partida (host) y comprobar que NO se puede iniciar con 1 jugador.
 *   3. Unir 2 jugadores más (mínimo 3) y comprobar 'start' bloqueado sin perfiles.
 *   4. Saves de perfil + relaciones de los 3 (el host con descripciones para
 *      probar también las "relaciones especiales").
 *   5. Host → POST /start → status 'generating'.
 *   6. El mock de IA (scripts/mock-ai-server.mjs) recibe el POST; se verifica
 *      que el JSON enviado (gameId, host, perfiles, relationships y
 *      specialRelationships) es EXACTAMENTE lo esperado.
 *   7. Verificación en Firestore (lectura con Admin SDK): games/{id} guarda
 *      mysteryContext (el JSON de los jugadores) y status 'ready'; y
 *      games/{id}/mystery/current guarda el payload devuelto por el mock.
 *   8. Abandono del host → partida cerrada (queda una tumba identificable).
 *
 * Requiere en marcha: mock-ai-server (:4010) y API con
 * AI_GENERATION_URL=http://127.0.0.1:4010/mystery.
 *
 * Uso:
 *   node scripts/e2e-mystery-smoke.mjs              # ejecuta el flujo
 *   node scripts/e2e-mystery-smoke.mjs --cleanup <gameId>   # borra test tombstone
 */
import 'dotenv/config';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const BASE = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:4000/api';
const MOCK_LAST = process.env.MOCK_AI_LAST_URL ?? 'http://127.0.0.1:4010/__last';
const RUN_TAG = String(Date.now()).slice(-6);
const TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers HTTP + aserciones
// ---------------------------------------------------------------------------

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, json };
}

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function assertEqualObject(actual, expected, label) {
  for (const key of Object.keys(expected)) {
    check(
      `${label}.${key}`,
      JSON.stringify(actual?.[key]) === JSON.stringify(expected[key]),
      `esperado ${JSON.stringify(expected[key])}, recibido ${JSON.stringify(actual?.[key])}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Firebase Admin (solo LECTURA; la limpieza es opcional con --cleanup)
// ---------------------------------------------------------------------------

function initAdmin() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey.includes('PRIVATE KEY')) {
    return null;
  }
  const app =
    getApps().find((entry) => entry.name === 'smoke-e2e') ??
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) }, 'smoke-e2e');
  return getFirestore(app);
}

// ---------------------------------------------------------------------------
// Eliminacion de la tumba de prueba (opt-in): borra games/{id} + subcolecciones
// ---------------------------------------------------------------------------

async function cleanup(gameId) {
  const db = initAdmin();
  if (!db) {
    console.log('⚠️ Sin credenciales de Firebase en apps/api/.env: no se puede limpiar.');
    process.exitCode = 1;
    return;
  }
  const ref = db.collection('games').doc(gameId);
  await db.recursiveDelete(ref);
  console.log(`🧹 Partida de prueba ${gameId} eliminada (incluido mystery).`);
}

// ---------------------------------------------------------------------------

function profileFor(name) {
  return {
    aboutMe: `${name}: curioso, observador y algo sarcástico`,
    job: `${name} trabaja de noche`,
    clothing: `${name} viste sudadera gris y zapatillas viejas`,
    hobbies: `${name}: ajedrez, senderismo y true crime`,
    drinks: `${name}: gin tónica y café con hielo`,
    fears: `${name} teme quedarse solo en el bosque`,
  };
}

async function main() {
  console.log('--- Smoke test del servicio de generación de misterios ---\n');

  // 1. Salud del backend
  let health = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      health = await api('/games/health');
      if (health.ok) break;
    } catch {
      // backend aún arrancando
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  check('health responde con Firebase', health?.json?.database === 'firebase', JSON.stringify(health?.json));

  // 2. Crear partida (host)
  const created = await api('/games', {
    method: 'POST',
    body: { displayName: 'Host de smoke', deviceId: `smoke-host-${RUN_TAG}` },
  });
  const gameId = created.json?.game?.id;
  const hostToken = created.json?.token;
  const hostId = created.json?.player?.id;
  check('crear partida (host)', created.status === 201 && Boolean(gameId), `gameId=${gameId}`);

  // 3. No se puede iniciar con un solo jugador (< 3)
  const early = await api(`/games/${gameId}/start`, { method: 'POST', token: hostToken });
  check(
    'start bloqueado con 1 jugador (409 GAME_NOT_READY)',
    early.status === 409 && early.json?.error?.code === 'GAME_NOT_READY',
    JSON.stringify(early.json?.error),
  );

  // 4. Union de 2 jugadores más
  const joins = await Promise.all([
    api('/games/join', {
      method: 'POST',
      body: { code: created.json.game.code, displayName: 'Invitado Uno', deviceId: `smoke-p2-${RUN_TAG}` },
    }),
    api('/games/join', {
      method: 'POST',
      body: { code: created.json.game.code, displayName: 'Invitado Dos', deviceId: `smoke-p3-${RUN_TAG}` },
    }),
  ]);
  const playersTokens = new Map([[hostId, { token: hostToken, name: 'Host de smoke' }]]);
  check('spawn jugador 2', joins[0].status === 200, '');
  check('spawn jugador 3', joins[1].status === 200, '');
  playersTokens.set(joins[0].json?.player?.id, { token: joins[0].json?.token, name: 'Invitado Uno' });
  playersTokens.set(joins[1].json?.player?.id, { token: joins[1].json?.token, name: 'Invitado Dos' });
  const playerIds = [...playersTokens.keys()];
  const [p2, p3] = playerIds.filter((id) => id !== hostId);

  // Perfiles: relaciones enviadas. El host SOLO describe rel. especial con p2,
  // p2 con el host, p3 con el host; el resto sin descripción (opcional).
  const relationPlan = new Map([
    [hostId, { [p2]: { level: 8, description: 'Somos amigos desde pequeños' }, [p3]: { level: 5, description: '' } }],
    [p2, { [hostId]: { level: 9, description: 'Amigos del instituto' }, [p3]: { level: 4, description: '' } }],
    [p3, { [hostId]: { level: 7, description: 'Compañeras de piso' }, [p2]: { level: 2, description: '' } }],
  ]);

  // 5. start bloqueado mientras quedan perfiles SIN completar (solo el host usted).
  const hostPatch = await api(`/games/${gameId}/profile`, {
    method: 'PATCH',
    token: hostToken,
    body: { profile: profileFor('Host de smoke'), relations: relationPlan.get(hostId) },
  });
  check('perfil del host guardado y completo', hostPatch.json?.profileCompleted === true, '');

  const blocked = await api(`/games/${gameId}/start`, { method: 'POST', token: hostToken });
  check(
    'start bloqueado con perfiles incompletos (409 GAME_NOT_READY)',
    blocked.status === 409 && blocked.json?.error?.code === 'GAME_NOT_READY',
    JSON.stringify(blocked.json?.error),
  );

  // Perfiles de los otros dos
  for (const [playerId, tokenEntry] of playersTokens) {
    if (playerId === hostId) continue;
    const saved = await api(`/games/${gameId}/profile`, {
      method: 'PATCH',
      token: tokenEntry.token,
      body: { profile: profileFor(tokenEntry.name), relations: relationPlan.get(playerId) },
    });
    check(`perfil de ${tokenEntry.name} completo`, saved.json?.profileCompleted === true, '');
  }

  // 6. El host comienza la partida
  const started = await api(`/games/${gameId}/start`, { method: 'POST', token: hostToken });
  check(
    'start aceptado → status generating',
    started.status === 200 && started.json?.game?.status === 'generating',
    JSON.stringify(started.json?.game ?? started.json),
  );

  // 7. Poll hasta 'ready' (el mock responde al instante); máx ~15 s
  let finalStatus = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const state = await api(`/games/${gameId}/state`, { token: hostToken });
    finalStatus = state.json?.game?.status;
    if (finalStatus === 'ready' || finalStatus === 'generation_error') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check("estado final 'ready'", finalStatus === 'ready', `status=${finalStatus}`);

  // 8. Verificar el POST que el backend envió al proveedor (mock)
  const lastRes = await fetch(MOCK_LAST, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const last = await lastRes.json();
  const ctx = last?.body?.mysteryContext;
  check('mock recibió un POST', Boolean(ctx), `recibido en ${last?.receivedAt ?? '∅'}`);
  if (ctx) {
    // El Authorization Bearer SOLO se envía si hay AI_GENERATION_API_KEY
    // configurada (comportamiento correcto del proveedor remoto).
    check(
      'POST: cabecera Authorization (solo si hay API key)',
      process.env.AI_GENERATION_API_KEY
        ? /^Bearer /.test(last.headers.authorization ?? '')
        : last.headers.authorization === null,
      // DETALLE SIN LA CLAVE: nunca pintar el valor del header.
      process.env.AI_GENERATION_API_KEY ? 'Bearer presente' : 'sin Bearer (esperado)',
    );
    check('POST: gameId correcto', ctx.gameId === gameId, ctx.gameId);
    check('POST: gameCode correcto', ctx.gameCode === created.json?.game?.code, ctx.gameCode);
    check('POST: hostId correcto', ctx.hostId === hostId, ctx.hostId);
    check('POST: participantCount = 3', ctx.participantCount === 3, String(ctx.participantCount));

    // Perfil de un jugador concreto (mapeo aboutMe→description, job→occupation, …)
    const hostCtx = ctx.players.find((player) => player.playerId === hostId);
    check('POST: 3 jugadores en players', ctx.players.length === 3, String(ctx.players.length));
    check('POST: username del host', hostCtx?.username === 'Host de smoke', hostCtx?.username);
    assertEqualObject(hostCtx?.profile, {
      description: profileFor('Host de smoke').aboutMe,
      occupation: profileFor('Host de smoke').job,
      clothing: profileFor('Host de smoke').clothing,
      habitsAndHobbies: profileFor('Host de smoke').hobbies,
      drinks: profileFor('Host de smoke').drinks,
      fears: profileFor('Host de smoke').fears,
    }, 'POST: profile host');
    check(
      'POST: relationships host (level 8→p2, 5→p3)',
      JSON.stringify(hostCtx?.relationships) === JSON.stringify([
        { targetPlayerId: p2, level: 8 },
        { targetPlayerId: p3, level: 5 },
      ]),
      JSON.stringify(hostCtx?.relationships),
    );
    check(
      'POST: specialRelationships solo descripción no vacía',
      JSON.stringify(hostCtx?.specialRelationships) === JSON.stringify([
        { targetPlayerId: p2, description: 'Somos amigos desde pequeños' },
      ]),
      JSON.stringify(hostCtx?.specialRelationships),
    );
  }

  // 9. Verificación en Firestore (lectura Admin): el JSON quedó en la partida
  const db = initAdmin();
  if (db) {
    const gameSnap = await db.collection('games').doc(gameId).get();
    const gameData = gameSnap.data() ?? {};
    check("Firestore: status 'ready'", gameData.status === 'ready', gameData.status);
    check('Firestore: partida SIN lastGenerationError', gameData.lastGenerationError === undefined, String(gameData.lastGenerationError));
    check('Firestore: mysteryContext presente', typeof gameData.mysteryContext === 'object' && gameData.mysteryContext !== null, '');
    check('Firestore: mysteryContext.players = 3', gameData.mysteryContext?.players?.length === 3, String(gameData.mysteryContext?.players?.length));
    check('Firestore: mysteryContext.gameId', gameData.mysteryContext?.gameId === gameId, gameData.mysteryContext?.gameId);

    const mysterySnap = await db.collection('games').doc(gameId).collection('mystery').doc('current').get();
    const mystery = mysterySnap.data() ?? {};
    check("Firestore: games/{id}/mystery/current existe", mysterySnap.exists, '');
    check("Firestore: generado por 'remote-http' (el mock)", mystery.provider === 'remote-http', String(mystery.provider));
    check('Firestore: payload del misterio almacenado', typeof mystery.payload === 'object' && mystery.payload !== null, '');
    check('Firestore: generatedAt (timestamp) presente', Boolean(mystery.generatedAt), String(mystery.generatedAt));

    // FASE 5: el payload persistido ya es el misterio COMPLETO y validado.
    const payload = mystery.payload ?? {};
    check('payload: título del misterio definido', typeof payload.title === 'string' && payload.title.length > 0, payload.title ?? '');
    check('payload: 3 personajes jugables', Array.isArray(payload.characters) && payload.characters.length === 3, String(payload.characters?.length));
    const storedVictims = (payload.characters ?? []).filter((c) => c.isVictim === true);
    const storedMurderers = (payload.characters ?? []).filter((c) => c.isMurderer === true);
    check(
      'payload: exactamente 1 víctima jugable (playerId real)',
      storedVictims.length === 1 && storedVictims[0] !== undefined &&
        payload.characters.some((c) => c.playerId === storedVictims[0].playerId),
      String(storedVictims[0]?.name ?? ''),
    );
    check(
      'payload: asesino único y distinto de la víctima',
      storedMurderers.length === 1 && storedMurderers[0] !== undefined &&
        storedMurderers[0].characterId === payload.solution?.murdererCharacterId &&
        storedMurderers[0].playerId !== storedVictims[0]?.playerId,
      '',
    );
    check('payload: cada playerId cubierto una vez', JSON.stringify((payload.characters ?? []).map((c) => c.playerId).sort()) === JSON.stringify([...playerIds].sort()), '');
    check('payload: al menos una habitación con pistas', (payload.rooms?.length ?? 0) >= 1 && (payload.rooms?.[0]?.clues?.length ?? 0) >= 1, '');
    check('payload: cronología con conocimiento público', (payload.timeline?.length ?? 0) >= 1 && typeof payload.timeline?.[0]?.publicKnowledge === 'string', '');

    console.log('\n📄 mysteryContext almacenado en games/' + gameId + ':');
    console.log(JSON.stringify(gameData.mysteryContext, null, 2));
    console.log('\n📦 mystery/current.payload (opaco, del mock):');
    console.log(JSON.stringify(mystery.payload, null, 2));
  } else {
    console.log('⚠️ No hay credenciales de Firebase para verificar Firestore directamente.');
    failures += 1;
  }

  // 9b. Vista por jugador (FASE 6): cada dispositivo ve SUS datos y roles.
  const views = [];
  for (const [playerIdEntry, tokenEntry] of playersTokens) {
    const answer = await api(`/games/${gameId}/mystery`, { token: tokenEntry.token });
    views.push({ playerId: playerIdEntry, status: answer.status, body: answer.json ?? {} });
  }
  check('mystery: 200 para los 3 jugadores (tras ready)', views.every((view) => view.status === 200), JSON.stringify(views.map((tree) => tree.status)));
  check('mystery: cada uno recibe SU personaje', views.every((view) => view.body.myCharacter?.playerId === view.playerId), '');
  check('mystery: exactamente un jugador ve isVictim=true', views.filter((view) => view.body.myCharacter?.isVictim === true).length === 1, '');
  check('mystery: el flag isMurderer solo aparece en la vista del asesino', views.filter((view) => 'isMurderer' in (view.body.myCharacter ?? {})).length === 1, '');
  check('mystery:.solution y resolution NUNCA viajan al cliente', views.every((view) => !('solution' in view.body) && !('resolution' in view.body)), '');
  check('mystery: rooms visibles con pistas para el llamador', views.every((view) => (view.body.rooms?.length ?? 0) >= 1), '');
  check('mystery: cronología sin el evento objetivo', views.every((view) => (view.body.timeline?.length ?? 0) >= 1 && !('event' in (view.body.timeline?.[0] ?? {}))), '');

  // 9c. FASE DE INVESTIGACIÓN: privacidad de la vista + atomicidad real.
  //      · El CONTENIDO de las pistas no viaja en la vista del misterio.
  //      · myCharacter.personalTimeline presente (≥ 1 punto, aquí ≥ 4 del mock).
  check(
    'mystery: las pistas de las rooms NO llevan content',
    views.every((view) =>
      (view.body.rooms ?? []).every((room) =>
        (room.clues ?? []).every((clue) => typeof clue.name === 'string' && !('content' in clue)),
      ),
    ),
    '',
  );
  check(
    'mystery: myCharacter.personalTimeline completa (mock: 4 puntos)',
    views.every((view) => (view.body.myCharacter?.personalTimeline?.length ?? 0) >= 4),
    JSON.stringify(views.map((view) => view.body.myCharacter?.personalTimeline?.length)),
  );
  check(
    'mystery: cada punto de la cronología lleva sus campos',
    views.every((view) =>
      (view.body.myCharacter?.personalTimeline ?? []).every(
        (point) =>
          typeof point.time === 'string' &&
          typeof point.location === 'string' &&
          typeof point.event === 'string' &&
          Array.isArray(point.involvedCharacterIds) &&
          typeof point.publicClaim === 'string',
      ),
    ),
    '',
  );

  // Estado inicial de la investigación. Mock: rooms [salón: clue-1 pública,
  // clue-2 SOLO del asesino; cocina: clue-3 pública]. Host y p2 ven 2 pistas;
  // el asesino ve 3.
  const murdererView = views.find((view) => view.body.myCharacter?.isMurderer === true);
  const murdererId = murdererView?.playerId;
  const murdererToken = murdererId ? playersTokens.get(murdererId)?.token : undefined;
  check('investigación: localizado el jugador asesino', Boolean(murdererToken), `murdererId=${murdererId}`);

  const initialStates = [];
  for (const [playerIdEntry, tokenEntry] of playersTokens) {
    const answer = await api(`/games/${gameId}/investigation`, { token: tokenEntry.token });
    initialStates.push({ playerId: playerIdEntry, status: answer.status, body: answer.json ?? {} });
  }
  check('investigación: 200 para los 3', initialStates.every((entry) => entry.status === 200), '');
  const stateOf = (playerId) => initialStates.find((entry) => entry.playerId === playerId)?.body ?? null;
  check(
    'investigación: elegibilidad exacta por jugador (2 pistas no asesino, 3 el asesino)',
    // El asesino del mock podría ser cualquiera de los 3 (rotate). Contamos
    // contra la vista del misterio: pistas por jugador según discoveredBy.
    views.length === 3 &&
      views.every((view) => {
        const eligibleCount = (view.body.rooms ?? []).reduce(
          (sum, room) => sum + (room.clues?.length ?? 0),
          0,
        );
        const state = stateOf(view.playerId);
        return (state?.clueStates?.length ?? -1) === eligibleCount;
      }),
    JSON.stringify(views.map((view) => [
      view.body.myCharacter?.isMurderer === true,
      (view.body.rooms ?? []).reduce((sum, room) => sum + (room.clues?.length ?? 0), 0),
      stateOf(view.playerId)?.clueStates?.length,
    ])),
  );
  check(
    'investigación: pistas sin descubrir empiezan available',
    initialStates.every((entry) => (entry.body.clueStates ?? []).every((clue) => clue.status === 'available' && clue.byPlayerId === null)),
    '',
  );
  check(
    'investigación: sin pistas descubiertas aún',
    initialStates.every((entry) => (entry.body.myDiscoveredClues?.length ?? 0) === 0),
    '',
  );
  check(
    'investigación: cuaderno vacío al empezar',
    initialStates.every((entry) => entry.body.notebook?.content === '' && entry.body.notebook?.updatedAt === null),
    '',
  );

  // Descubrimiento CONCURRENTE de clue-1 (pública): claim en Promise.all con
  // dos jugadores no asesinos → EXACTO un ganador; el otro recibe 409
  // CLUE_UNAVAILABLE (la transacción decide, nunca el móvil).
  const clue1 = stateOf(playerIds[0])?.clueStates?.find((clue) => clue.status === 'available' && clue.roomId !== '');
  const clue1Id = clue1?.clueId;
  check('investigación: localizada una pista pública para la carrera', Boolean(clue1Id), `clueId=${clue1Id}`);
  const racers = [...playersTokens.entries()].filter(([id]) => id !== murdererId);
  const race = await Promise.all(
    racers.map(([id, entry]) => api(`/games/${gameId}/clues/${clue1Id}/claim`, { method: 'POST', token: entry.token })),
  );
  const raceWinners = race.filter((result) => result.status === 200);
  const raceLosers = race.filter((result) => result.status !== 200);
  check(
    'investigación: carrera concurrente → exactamente 1 reserva',
    raceWinners.length === 1 && raceLosers.length === 1,
    `200=${raceWinners.length} otros=${raceLosers.length}`,
  );
  check(
    'investigación: el perdedor recibe 409 CLUE_UNAVAILABLE',
    raceLosers.length === 1 && raceLosers[0]?.status === 409 && raceLosers[0]?.json?.error?.code === 'CLUE_UNAVAILABLE',
    JSON.stringify(raceLosers[0]?.json?.error),
  );
  const raceWinnerIndex = race.findIndex((result) => result.status === 200);
  if (raceWinnerIndex === -1) {
    check('investigación: hay ganador de la carrera', false, 'ningún claim devolvió 200; abortando la fase de pistas');
    throw new Error('smoke: fase de investigación sin reservas iniciales');
  }
  const raceWinnerEntry = racers[raceWinnerIndex][1];
  const raceWinnerId = racers[raceWinnerIndex][0];

  // reveal del ganador: contenido íntegro y permanente.
  const winnerReveal = await api(`/games/${gameId}/clues/${clue1Id}/reveal`, { method: 'POST', token: raceWinnerEntry.token });
  check(
    'investigación: reveal del ganador → 200 con contenido',
    winnerReveal.status === 200 && typeof winnerReveal.json?.content === 'string' && winnerReveal.json.content.length > 0 &&
      winnerReveal.json.clueId === clue1Id,
    `len=${winnerReveal.json?.content?.length}`,
  );
  // reveal idempotente: repetirlo redevuelve el contenido.
  const winnerReveal2 = await api(`/games/${gameId}/clues/${clue1Id}/reveal`, { method: 'POST', token: raceWinnerEntry.token });
  check(
    'investigación: reveal idempotente para su dueño',
    winnerReveal2.status === 200 && winnerReveal2.json?.content === winnerReveal.json?.content,
    '',
  );
  // reveal del perdedor sin reserva → 409.
  const loserToken = racers.find(([id]) => id !== raceWinnerId)[1].token;
  const loserReveal = await api(`/games/${gameId}/clues/${clue1Id}/reveal`, { method: 'POST', token: loserToken });
  check(
    'investigación: reveal sin reserva propia → 409',
    loserReveal.status === 409 && loserReveal.json?.error?.code === 'CLUE_UNAVAILABLE',
    JSON.stringify(loserReveal.json?.error),
  );
  // claim de una pista YA descubierta → 409.
  const reClaimLost = await api(`/games/${gameId}/clues/${clue1Id}/claim`, { method: 'POST', token: loserToken });
  check(
    'investigación: claim sobre pista descubierta por otro → 409',
    reClaimLost.status === 409 && reClaimLost.json?.error?.code === 'CLUE_UNAVAILABLE',
    JSON.stringify(reClaimLost.json?.error),
  );

  // Elegibilidad: una pista PRIVADA del asesino (clue-2) no la puede otro.
  // Es la pista que SOLO aparece en la vista del misterio del asesino.
  let privateClueId = null;
  const murdererStateIds = new Set((stateOf(murdererId)?.clueStates ?? []).map((clue) => clue.clueId));
  for (const clueId of murdererStateIds) {
    const nobodyElseHas = views
      .filter((view) => view.playerId !== murdererId)
      .every((view) => !(view.body.rooms ?? []).some((room) => (room.clues ?? []).some((clue) => clue.clueId === clueId)));
    if (nobodyElseHas) privateClueId = clueId;
  }
  if (privateClueId) {
    const ineligibleClaim = await api(`/games/${gameId}/clues/${privateClueId}/claim`, { method: 'POST', token: loserToken });
    check(
      'investigación: pista privada del asesino → 403 para otro jugador',
      ineligibleClaim.status === 403 && ineligibleClaim.json?.error?.code === 'CLUE_UNAVAILABLE',
      JSON.stringify(ineligibleClaim.json?.error),
    );
    const murdererClaim = await api(`/games/${gameId}/clues/${privateClueId}/claim`, { method: 'POST', token: murdererToken });
    check(
      'investigación: el asesino SÍ puede reservar su pista privada',
      murdererClaim.status === 200,
      JSON.stringify(murdererClaim.json),
    );
    // Release: el asesino libera y otro jugador NO gana acceso (sigue siendo privada).
    const murdererRelease = await api(`/games/${gameId}/clues/${privateClueId}/release`, { method: 'POST', token: murdererToken });
    check(
      'investigación: release de la reserva propia → ok',
      murdererRelease.status === 200 && murdererRelease.json?.ok === true,
      '',
    );
    const afterReleaseState = await api(`/games/${gameId}/investigation`, { token: murdererToken });
    check(
      'investigación: tras release la pista vuelve a available',
      (afterReleaseState.json?.clueStates ?? []).some((clue) => clue.clueId === privateClueId && clue.status === 'available'),
      '',
    );
  } else {
    check('investigación: pista privada localizada en el mock', false, 'el mock no produjo clue solo-para-asesino');
  }

  // Reserva → reveal del asesino en clue-3 (pública, otra habitación): el
  // estado registrado queda permanente y visible en myDiscoveredClues.
  const murdererClue3 = (stateOf(murdererId)?.clueStates ?? []).find(
    (clue) => clue.clueId !== clue1Id && clue.clueId !== privateClueId,
  );
  if (murdererClue3) {
    const mClaim = await api(`/games/${gameId}/clues/${murdererClue3.clueId}/claim`, { method: 'POST', token: murdererToken });
    const mReveal = await api(`/games/${gameId}/clues/${murdererClue3.clueId}/reveal`, { method: 'POST', token: murdererToken });
    check(
      'investigación: claim+reveal de una segunda pista → descubierta',
      mClaim.status === 200 && mReveal.status === 200 && typeof mReveal.json?.content === 'string',
      '',
    );
    const murdererStateAfter = await api(`/games/${gameId}/investigation`, { token: murdererToken });
    check(
      'investigación: myDiscoveredClues del dueño (solo sus pistas, con contenido)',
      (murdererStateAfter.json?.myDiscoveredClues?.length ?? 0) === 1 &&
        murdererStateAfter.json.myDiscoveredClues.every(
          (clue) => clue.clueId === murdererClue3.clueId && typeof clue.content === 'string' && clue.content.length > 0,
        ),
      JSON.stringify(murdererStateAfter.json?.myDiscoveredClues?.map((clue) => [clue.clueId, clue.content?.length])),
    );
    const winnerStateAfter = await api(`/games/${gameId}/investigation`, { token: raceWinnerEntry.token });
    check(
      'investigación: myDiscoveredClues solo del llamador (el ganador ve 1, no las del asesino)',
      (winnerStateAfter.json?.myDiscoveredClues?.length ?? 0) === 1 &&
        winnerStateAfter.json.myDiscoveredClues.every((clue) => clue.clueId === clue1Id),
      JSON.stringify(winnerStateAfter.json?.myDiscoveredClues?.map((clue) => clue.clueId)),
    );
    check(
      'investigación: estados sincronizados (pista del asesino en discovered con byPlayerId)',
      (winnerStateAfter.json?.clueStates ?? []).some(
        (clue) => clue.clueId === murdererClue3.clueId && clue.status === 'discovered' && clue.byPlayerId === murdererId,
      ),
      '',
    );
  }

  // Cuaderno privado: aislado POR JUGADOR y validación del límite de tamaño.
  const HOST = playersTokens.get(hostId);
  const notebookWrite = await api(`/games/${gameId}/notebook`, {
    method: 'PUT',
    token: HOST.token,
    body: { content: 'Suspechas: la copa es de p2…\nNota 2: el horario no cuadra.' },
  });
  check('cuaderno: autoguardado del host → ok', notebookWrite.status === 200 && notebookWrite.json?.ok === true, '');
  const notebookRead = await api(`/games/${gameId}/notebook`, { token: HOST.token });
  check(
    'cuaderno: el host lee SU texto',
    notebookRead.status === 200 && notebookRead.json?.content?.includes('Suspechas: la copa es de p2'),
    JSON.stringify(notebookRead.json),
  );
  const notebookOther = await api(`/games/${gameId}/notebook`, { token: loserToken });
  check(
    'cuaderno: PRIVACIDAD → otro jugador sigue viendo vacío',
    notebookOther.status === 200 && notebookOther.json?.content === '',
    JSON.stringify(notebookOther.json),
  );
  const notebookTooBig = await api(`/games/${gameId}/notebook`, {
    method: 'PUT',
    token: HOST.token,
    body: { content: 'x'.repeat(20_001) },
  });
  check(
    'cuaderno: límite de 20000 caracteres (400/413 controlado)',
    (notebookTooBig.status === 400 || notebookTooBig.status === 413) && notebookTooBig.json?.error?.code === 'VALIDATION_ERROR',
    JSON.stringify(notebookTooBig.json?.error),
  );
  const stateAfterNotebook = await api(`/games/${gameId}/investigation`, { token: HOST.token });
  check(
    'cuaderno: también viaja en el estado de investigación',
    stateAfterNotebook.json?.notebook?.content?.includes('Suspechas') === true &&
      typeof stateAfterNotebook.json?.notebook?.updatedAt === 'string',
    '',
  );

  // 10. Abandono del host → cerrar la partida (tumba identificable)
  const leave = await api(`/games/${gameId}/leave`, { method: 'POST', token: hostToken });
  check('abandono del host → partida cerrada', leave.status === 200, `gameId=${gameId}`);

  console.log(
    `\n=== RESULTADO: ${failures === 0 ? 'TODO OK' : `${failures} comprobación(es) fallaron`} ===` +
      `\nPartida de prueba: ${gameId} (queda como tumba 'closed'; bórrala en la consola de` +
      ` Firebase o con: node scripts/e2e-mystery-smoke.mjs --cleanup ${gameId})\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------

if (process.argv[2] === '--cleanup') {
  const gameId = process.argv[3];
  if (!gameId) {
    console.error('Uso: node scripts/e2e-mystery-smoke.mjs --cleanup <gameId>');
    process.exit(1);
  }
  await cleanup(gameId);
} else {
  await main();
}
