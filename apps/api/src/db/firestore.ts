import { cert, initializeApp, getApps, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { env, isFirebaseConfigured } from '../config/env.js';
import { httpError } from '../utils/errors.js';

let dbInstance: Firestore | null = null;

/** Acceso perezoso a Firestore: la app solo inicializa si alguien la usa. */
export function getFirestoreDb(): Firestore {
  if (!isFirebaseConfigured()) {
    // Error deliberadamente explícito: guiar al desarrollador al setup.
    throw httpError(
      503,
      'BACKEND_NOT_CONFIGURED',
      'El backend no tiene credenciales de Firebase. Configura FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL y FIREBASE_PRIVATE_KEY en apps/api/.env',
    );
  }
  if (!dbInstance) {
    const app: App =
      getApps().find((a) => a.name === 'mystery-api') ??
      initializeApp(
        {
          credential: cert({
            projectId: env.firebase.projectId,
            clientEmail: env.firebase.clientEmail,
            privateKey: env.firebase.privateKey,
          }),
        },
        'mystery-api',
      );
    dbInstance = getFirestore(app);
  }
  return dbInstance;
}
