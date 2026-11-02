import { config as loadEnv } from 'dotenv';

// Carga .env del paquete api. En producción se usan variables de entorno
// reales; dotenv solo facilita el desarrollo local.
loadEnv();

/**
 * Configuración leída del entorno una sola vez. Las credenciales de Firebase
 * NUNCA viven en el código ni en el cliente móvil: solo este proceso las lee.
 * La clave privada se pega en el .env con \n escapados; aquí se restaura.
 */
export const env = {
  port: Number(process.env.PORT ?? 4000),
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID ?? '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? '',
    privateKey: (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
  },
} as const;

/**
 * Indica si el backend puede hablar con Firestore. Se comprueba al arrancar
 * y en cada endpoint: sin credenciales respondemos 503 con instrucciones
 * claras en lugar de fallar con un error críptico (o fingir que funciona).
 */
export function isFirebaseConfigured(): boolean {
  const { projectId, clientEmail, privateKey } = env.firebase;
  return projectId.length > 0 && clientEmail.length > 0 && privateKey.includes('PRIVATE KEY');
}
