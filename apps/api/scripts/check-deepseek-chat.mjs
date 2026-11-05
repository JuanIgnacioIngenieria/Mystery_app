/**
 * VERIFICA la comunicación real con el endpoint de chat de DeepSeek con los
 * MISMOs parámetros que usará el proveedor de misterios (json_object + auth).
 * Pide un json mínimo: coste despreciable (< 1 céntimo).
 *
 * Comprueba:
 *  1. La clave autentica y el endpoint responde (401/402 se ven aquí).
 *  2. `response_format: json_object` es aceptado por el modelo configurado.
 *  3. El `content` final es json parseable (independiente de thinking).
 *
 * Uso:  node scripts/check-deepseek-chat.mjs
 */
import 'dotenv/config';

const apiKey = process.env.AI_GENERATION_API_KEY ?? '';
const model = process.env.AI_GENERATION_MODEL ?? 'deepseek-flash';
const url = process.env.AI_GENERATION_URL ?? 'https://api.deepseek.com/chat/completions';
const mask = apiKey.length > 12 ? `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}` : '(vacía)';

if (!apiKey.startsWith('sk-')) {
  console.error(`❌ AI_GENERATION_API_KEY no parece válida: ${mask}`);
  process.exit(1);
}

console.log(`📡 POST ${url} (modelo ${model}, thinking disabled, json_object)…`);

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'Responde únicamente con un objeto json.' },
      { role: 'user', content: 'Devuelve exactamente este json: {"ok":true,"app":"mystery"}' },
    ],
    response_format: { type: 'json_object' },
    thinking: { type: 'disabled' },
    max_tokens: 512,
    stream: false,
  }),
  signal: AbortSignal.timeout(60_000),
});

if (!res.ok) {
  console.error(
    `❌ HTTP ${res.status}` +
      (res.status === 401 ? ' (clave inválida)' : '') +
      (res.status === 402 ? ' (saldo agotado)' : '') +
      ` — ${await res.text()}`,
  );
  process.exit(1);
}

const envelope = await res.json();
const choice = envelope.choices?.[0];
const content = choice?.message?.content;
const finishReason = choice?.finish_reason;
const usage = envelope.usage ?? {};

console.log(
  `✅ HTTP ${
    res.status
  } · finish_reason=${finishReason} · tokens prompt=${usage.prompt_tokens ?? '?'} completion=${
    usage.completion_tokens ?? '?'
  }`,
);

let parsed = null;
try {
  parsed = JSON.parse(content);
} catch {
  /* manejado abajo */
}
if (parsed && parsed.ok === true && parsed.app === 'mystery') {
  console.log(`✅ content es el json esperado: ${content}`);
  console.log('✅ Comunicación con DeepSeek verificada: params json_object + auth correctos.');
} else {
  console.error(`❌ content inesperado: ${JSON.stringify(content)}`);
  process.exit(1);
}
