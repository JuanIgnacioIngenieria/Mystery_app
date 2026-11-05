import { config as loadEnv } from 'dotenv';

// Carga .env del paquete api. En producción se usan variables de entorno
// reales; dotenv solo facilita el desarrollo local.
loadEnv();

const rawGenerationTimeout = Number(process.env.AI_GENERATION_TIMEOUT_MS ?? '');
const generationTimeoutMs =
  Number.isFinite(rawGenerationTimeout) && rawGenerationTimeout > 0 ? rawGenerationTimeout : 120_000;

const rawGenerationMaxTokens = Number(process.env.AI_GENERATION_MAX_TOKENS ?? '');
const generationMaxTokens =
  Number.isFinite(rawGenerationMaxTokens) && rawGenerationMaxTokens > 0 ? rawGenerationMaxTokens : 65_536;

/**
 * Configuración leída del entorno una sola vez. Las credenciales de Firebase
 * y del proveedor de IA NUNCA viven en el código ni en el cliente móvil:
 * solo este proceso las lee. La clave privada se pega en el .env con \n
 * escapados; aquí se restaura.
 */
export const env = {
  port: Number(process.env.PORT ?? 4000),
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID ?? '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? '',
    privateKey: (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
  },
  /**
   * Proveedor de generación de misterios. La integración real existe hoy
   * (DeepSeek): AI_GENERATION_PROVIDER elige el proveedor y las variables
   * AI_GENERATION_* aportan la credencial, el endpoint y el modelo. Todo
   * sustituible desde .env: la partida, el contexto y la persistencia del
   * resultado NO cambian.
   */
  generation: {
    /** Endpoint HTTP del proveedor (POST del contexto, respuesta JSON). */
    requestUrl: (process.env.AI_GENERATION_URL ?? '').trim(),
    /** Credencial del proveedor: solo backend, nunca en la app. */
    apiKey: process.env.AI_GENERATION_API_KEY ?? '',
    /** Modelo de generación (p. ej. deepseek-flash | deepseek-v4-pro). */
    model: (process.env.AI_GENERATION_MODEL ?? 'deepseek-flash').trim(),
    /**
     * Proveedor concreto que construye el orquestador: 'deepseek' hoy.
     * Vacío = proveedor HTTP genérico (remote-provider, p. ej. el mock de
     * pruebas scripts/mock-ai-server.mjs).
     */
    provider: (process.env.AI_GENERATION_PROVIDER ?? '').trim(),
    /** Modo thinking del modelo: 'enabled' (calidad) | 'disabled' (rápido). */
    thinking:
      (process.env.AI_GENERATION_THINKING ?? 'enabled').trim().toLowerCase() === 'disabled'
        ? 'disabled'
        : 'enabled',
    /** Límite de tokens de salida para el JSON del misterio (alto a propósito). */
    maxTokens: generationMaxTokens,
    /** Presupuesto máximo de espera del proveedor (AbortController). */
    timeoutMs: generationTimeoutMs,
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

/**
 * Indica si hay proveedor de generación configurado. Es el guard del inicio
 * de partida: sin él, /start responde 503 inmediato en lugar de transicionar
 * a 'generating' para un intento condenado de antemano.
 */
export function isGenerationConfigured(): boolean {
  return env.generation.requestUrl.length > 0;
}
