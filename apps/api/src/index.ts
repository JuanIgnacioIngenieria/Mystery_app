import { createApp } from './app.js';
import { env, isFirebaseConfigured } from './config/env.js';

const app = createApp();

app.listen(env.port, () => {
  console.log(`[api] escuchando en http://localhost:${env.port}/api`);
  if (!isFirebaseConfigured()) {
    // Mensaje visible en cada arranque hasta que el proyecto esté conectado:
    // ningún endpoint fingirá funcionamiento con datos fake.
    console.warn(
      '[api] ⚠️  Firebase NO configurado. Los endpoints de partida responderán 503.\n' +
        '     Configura FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL y FIREBASE_PRIVATE_KEY en apps/api/.env',
    );
  }
});
