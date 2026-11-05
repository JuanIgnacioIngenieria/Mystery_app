import { env } from '../../config/env.js';
import type { MysteryGenerationProvider } from './contract.js';
import { MysteryGenerationError } from './contract.js';
import { buildMysteryUserPrompt, MYSTERY_SYSTEM_PROMPT } from './prompts.js';

// ---------------------------------------------------------------------------
// PROVEEDOR DeepSeek (https://api-docs.deepseek.com).
//
// API OpenAI-compatible: POST { requestUrl } (= https://api.deepseek.com/chat
// completions) con Authorization Bearer. Usa el JSON Output oficial
// (response_format: json_object) + max_tokens alto (el JSON del misterio es
// largo; cortarlo a mitad lo haría inválido) y el modo "thinking" configurable
// (mejor coherencia narrativa a cambio de más tokens y latencia).
//
// Rareza documentada del JSON Output: si el modelo produce contenido no-json,
// la API lo sustituye por espacios → puede llegar `content` vacío (solo
// U+0020) incluso con finish_reason 'stop'. Por eso se REINTENTA con tope.
//
// Manejo de fallos clasificado igual que el resto de proveedores (contract.ts):
// timeout → GENERATION_TIMEOUT, red → GENERATION_UNREACHABLE,
// 401/402/422/429/500/503 → GENERATION_HTTP_ERROR con el estado como pista,
// envoltura o json de content inválidos → GENERATION_INVALID_RESPONSE.
//
// Cambiar de proveedor en el futuro = crear otro archivo así y añadirlo al
// selector de mystery.service.ts (o rellenar .env si es HTTP genérico).
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Intentos totales ante `content` vacío (incluye el primero). */
const MAX_ATTEMPTS = 3;

/** Envoltura parcial de la respuesta de /chat/completions (formato OpenAI). */
interface ChatCompletionEnvelope {
  choices?: Array<{
    message?: {
      content?: unknown;
      /** Razonamiento del modo thinking (no es la respuesta final). */
      reasoning_content?: unknown;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Mensaje legible (para lastGenerationError) según el estado de DeepSeek. */
function httpMessageFor(status: number): string {
  switch (status) {
    case 400:
      return 'DeepSeek rechazó la petición (400, formato inválido).';
    case 401:
      return 'La credencial del proveedor de generación no es válida (401).';
    case 402:
      return 'El proveedor de generación no tiene saldo (402).';
    case 422:
      return 'DeepSeek rechazó los parámetros de la petición (422).';
    case 429:
      return 'El proveedor de generación está saturado (429, límite de peticiones).';
    case 500:
    case 503:
      return `El proveedor de generación falló internamente (${status}); reintentar más tarde.`;
    default:
      return `El proveedor de generación respondió con HTTP ${status}.`;
  }
}

/** Extrae el `public content` final (vacío/espacios → null, permite reintento). */
function readContent(envelope: ChatCompletionEnvelope): string | null {
  const choice = envelope.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  return trimmed.length > 0 ? content : null;
}

function readFinishReason(envelope: ChatCompletionEnvelope): string {
  return envelope.choices?.[0]?.finish_reason ?? 'desconocido';
}

/** Solo telemetría de uso (tokens consumidos: permite coste estimado). */
function logUsage(envelope: ChatCompletionEnvelope, model: string, attempt: number): void {
  const usage = envelope.usage;
  if (!usage) return;
  console.log(
    `[api] deepseek (${model}, intento ${attempt}): ` +
      `prompt=${usage.prompt_tokens ?? '?'} completion=${usage.completion_tokens ?? '?'} ` +
      `total=${usage.total_tokens ?? '?'} tokens`,
  );
}

/** Parsea el json narrativo del content (el contrato debe ser un objeto). */
function parseMysteryJson(content: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new MysteryGenerationError(
      'GENERATION_INVALID_RESPONSE',
      'DeepSeek devolvió content sin un json parseable.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MysteryGenerationError(
      'GENERATION_INVALID_RESPONSE',
      'DeepSeek devolvió un json que no es el objeto del misterio.',
    );
  }
  return parsed;
}

/**
 * Sin URL o sin clave el proveedor NO se instancia (igual que remote-http):
 * el guard isGenerationConfigured() responde 503 controlado antes de llegar
 * aquí.
 */
export function createDeepseekProvider(): MysteryGenerationProvider | null {
  const url = env.generation.requestUrl.trim();
  const apiKey = env.generation.apiKey;
  const model = env.generation.model;
  if (url.length === 0 || apiKey.length === 0) return null;

  return {
    name: 'deepseek',

    async generate(request) {
      const body = {
        model,
        messages: [
          { role: 'system', content: MYSTERY_SYSTEM_PROMPT },
          { role: 'user', content: buildMysteryUserPrompt(request.context) },
        ],
        /** JSON Output oficial (exige la palabra «json» + ejemplo en el prompt: prompts.ts). */
        response_format: { type: 'json_object' },
        /** Alto a propósito: cortar el json a mitad lo haría inválido. */
        max_tokens: env.generation.maxTokens,
        /** Modo thinking del modelo (enabled por defecto, configurable en .env). */
        thinking: { type: env.generation.thinking },
        stream: false,
      };

      let lastFinishReason = 'desconocido';
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), env.generation.timeoutMs);

        let response: Response;
        try {
          response = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
          });
        } catch (cause) {
          if (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError')) {
            throw new MysteryGenerationError(
              'GENERATION_TIMEOUT',
              `DeepSeek no respondió en ${env.generation.timeoutMs} ms.`,
            );
          }
          throw new MysteryGenerationError(
            'GENERATION_UNREACHABLE',
            'No se pudo conectar con DeepSeek.',
          );
        } finally {
          clearTimeout(timeout);
        }

        if (!response.ok) {
          // El cuerpo del error de DeepSeek (error.message / error.type) dice el
          // parámetro exacto rechazado: se registra recortado para depurar (a
          // lastGenerationError solo llega la razón legible por estado).
          const detail = (await response.text().catch(() => '')).slice(0, 500);
          if (detail.trim().length > 0) {
            console.warn(`[api] deepseek: HTTP ${response.status} → ${detail.trim()}`);
          }
          throw new MysteryGenerationError(
            'GENERATION_HTTP_ERROR',
            httpMessageFor(response.status),
            response.status,
          );
        }

        let envelope: ChatCompletionEnvelope;
        try {
          envelope = (await response.json()) as ChatCompletionEnvelope;
        } catch {
          throw new MysteryGenerationError(
            'GENERATION_INVALID_RESPONSE',
            'DeepSeek no devolvió una envoltura json válida.',
          );
        }
        logUsage(envelope, model, attempt);

        const content = readContent(envelope);
        if (content === null) {
          // Rareza documentada: content casi vacío aunque finish_reason sea
          // 'stop' → reintento con pequeño backoff; agotado → error
          // GENERATION_INVALID_RESPONSE para la partida.
          lastFinishReason = readFinishReason(envelope);
          console.warn(
            `[api] deepseek: content vacío (intento ${attempt}/${MAX_ATTEMPTS}, ` +
              `finish_reason=${lastFinishReason}); reintentando…`,
          );
          if (attempt < MAX_ATTEMPTS) await sleep(1_000 * attempt);
          continue;
        }

        return parseMysteryJson(content);
      }

      throw new MysteryGenerationError(
        'GENERATION_INVALID_RESPONSE',
        `DeepSeek devolvió respuestas vacías tras ${MAX_ATTEMPTS} intentos (finish_reason=${lastFinishReason}).`,
      );
    },
  };
}
