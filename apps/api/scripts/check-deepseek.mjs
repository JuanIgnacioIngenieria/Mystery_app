/**
 * Verifica las credenciales de DeepSeek configuradas en apps/api/.env
 * sin exponerlas. Utilidad de pruebas: NO forma parte de la API.
 *
 * Qué hace:
 *  1. Comprueba que AI_GENERATION_API_KEY tiene formato sk-... (la pinta
 *     siempre mascarada, nunca completa).
 *  2. Consulta GET https://api.deepseek.com/models con la clave (no consume
 *     saldo ni genera tokens) y lista los modelos disponibles.
 *  3. Verifica que el modelo configurado (AI_GENERATION_MODEL) está en la
 *     lista; si no, avisa para revisar platform.deepseek.com.
 *
 * Uso:  node scripts/check-deepseek.mjs
 */
import 'dotenv/config';

const apiKey = process.env.AI_GENERATION_API_KEY ?? '';
const model = process.env.AI_GENERATION_MODEL ?? 'deepseek-flash';
const mask = apiKey.length > 12 ? `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}` : '(vacía)';

if (!apiKey.startsWith('sk-') || apiKey.length < 20) {
  console.error(`❌ AI_GENERATION_API_KEY no parece válida: ${mask}`);
  process.exit(1);
}
console.log(`✅ Clave presente (${mask}), modelo configurado: ${model}`);

let res;
try {
  res = await fetch('https://api.deepseek.com/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
} catch (error) {
  console.error(`❌ No se pudo conectar con api.deepseek.com: ${error.message}`);
  process.exit(1);
}

if (!res.ok) {
  console.error(
    `❌ /models respondió HTTP ${res.status}` +
      (res.status === 401 ? ' (clave inválida: regenera en platform.deepseek.com/api_keys)' : '') +
      (res.status === 402 ? ' (saldo agotado: revisa platform.deepseek.com/top_up)' : ''),
  );
  process.exit(1);
}

const body = await res.json();
const ids = (body.data ?? []).map((entry) => entry.id);
console.log(`✅ Modelos disponibles: ${ids.join(', ')}`);
console.log(
  ids.includes(model)
    ? `✅ El modelo '${model}' está disponible.`
    : `⚠️ El modelo '${model}' NO está en la lista: revisa platform.deepseek.com`,
);
process.exitCode = ids.includes(model) ? 0 : 1;
