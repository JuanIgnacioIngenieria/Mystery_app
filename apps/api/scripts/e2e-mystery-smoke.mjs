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
