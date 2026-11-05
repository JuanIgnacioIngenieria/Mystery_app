/**
 * DIAGNÓSTICO puntual: lee el estado de una partida y subcoleccion clave.
 * Uso: node scripts/debug-game.mjs <gameId>
 */
import 'dotenv/config';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const gameId = process.argv[2];
if (!gameId) {
  console.error('Uso: node scripts/debug-game.mjs <gameId>');
  process.exit(1);
}

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
const app =
  getApps().find((entry) => entry.name === 'debug-game') ??
  initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) }, 'debug-game');
const db = getFirestore(app);

const gameSnap = await db.collection('games').doc(gameId).get();
console.log('status:', gameSnap.data()?.status);
console.log('lastGenerationError:', JSON.stringify(gameSnap.data()?.lastGenerationError ?? null));
console.log(
  'generationStartedAt:',
  gameSnap.data()?.generationStartedAt?.toDate?.().toISOString() ?? null,
);
const current = await db.collection('games').doc(gameId).collection('mystery').doc('current').get();
console.log('mystery/current existe:', current.exists, 'provider:', current.data()?.provider ?? '-');
