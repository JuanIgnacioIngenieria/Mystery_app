import { env } from '../../config/env.js';
import type { MysteryGenerationProvider } from './contract.js';
import { MysteryGenerationError } from './contract.js';

/**
 * Proveedor por HTTP genérico: POST JSON del contexto a AI_GENERATION_URL con
 * Authorization Bearer (si hay clave). NO está conectado a nadie todavía: solo
 * se instancia si AI_GENERATION_URL está definida en el .env; por defecto el
 * orquestador ni siquiera lo usa y responde 503 controlado.
 *
 * Manejo de fallos clasificado para depuración (§ errores de generación):
 * timeout (AbortController → GENERATION_TIMEOUT), no alcanzable
 * (GENERATION_UNREACHABLE), estado HTTP incorrecto (GENERATION_HTTP_ERROR) y
 * respuesta no-JSON / no-objeto (GENERATION_INVALID_RESPONSE).
 */
export function createRemoteMysteryProvider(): MysteryGenerationProvider | null {
  const url = env.generation.requestUrl.trim();
  if (url.length === 0) return null; // Sin proveedor configurado: no se instancia.

  return {
    name: 'remote-http',

    async generate(request) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), env.generation.timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(env.generation.apiKey.length > 0
              ? { Authorization: `Bearer ${env.generation.apiKey}` }
              : null),
          },
          body: JSON.stringify({ mysteryContext: request.context }),
        });
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'AbortError') {
          throw new MysteryGenerationError(
            'GENERATION_TIMEOUT',
            `El proveedor de IA no respondió en ${env.generation.timeoutMs} ms.`,
          );
        }
        throw new MysteryGenerationError(
          'GENERATION_UNREACHABLE',
          'No se pudo conectar con el proveedor de IA.',
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new MysteryGenerationError(
          'GENERATION_HTTP_ERROR',
          `El proveedor de IA respondió con HTTP ${response.status}.`,
          response.status,
        );
      }

      // El resultado debe ser un objeto JSON (el payload narrativo es opaco:
      // el contrato se definirá cuando se elija el proveedor real).
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new MysteryGenerationError(
          'GENERATION_INVALID_RESPONSE',
          'El proveedor de IA no devolvió un JSON válido.',
        );
      }
      if (typeof payload !== 'object' || payload === null) {
        throw new MysteryGenerationError(
          'GENERATION_INVALID_RESPONSE',
          'El proveedor de IA devolvió una respuesta sin el formato esperado.',
        );
      }
      return payload;
    },
  };
}
