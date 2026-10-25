// GET /api/farm/:id
// Orden de búsqueda:
//   1. Base D1 (la actualiza el Worker programado): si tiene menos de FARM_DB_MAX_AGE_MIN, se usa directo.
//   2. Caché del edge (5 minutos).
//   3. Community API de Sunflower Land (con SFL_API_KEY).
//   4. Si la API limita (429) o falla: última copia de D1 o del edge, marcada como "stale".
import { fetchFarmUpstream, readLatestFarm, writeLatestFarm } from "../../../shared/sfl.js";

const STALE_SECONDS = 86400;

export async function onRequestGet({ params, env, request, waitUntil }) {
  const id = String(params.id || "").replace(/\D/g, "");
  if (!id) return json({ error: "El ID de granja tiene que ser numérico." }, 400);

  const db = env.DB || null;
  const fresh = Number(env.FARM_CACHE_SECONDS) || 300;
  const dbMaxAge = (Number(env.FARM_DB_MAX_AGE_MIN) || 35) * 60e3;

  // 1. D1
  const stored = await readLatestFarm(db, id).catch(() => null);
  if (stored && Date.now() - Date.parse(stored.fetchedAt) < dbMaxAge) {
    return json({ ...stored, source: "d1" }, 200, 60);
  }

  // 2. Edge
  const cache = caches.default;
  const freshKey = new Request(new URL(`/__cache/farm/${id}`, request.url).toString());
  const staleKey = new Request(new URL(`/__cache/farm-stale/${id}`, request.url).toString());
  const hit = await cache.match(freshKey);
  if (hit) return hit;

  // 3. API
  try {
    const data = await fetchFarmUpstream(env, id);
    const body = { fetchedAt: new Date().toISOString(), source: "api", data };
    const out = json(body, 200, fresh);
    waitUntil(cache.put(freshKey, out.clone()));
    waitUntil(cache.put(staleKey, json(body, 200, STALE_SECONDS)));
    if (db) waitUntil(writeLatestFarm(db, id, data, body.fetchedAt).catch(() => {}));
    return out;
  } catch (err) {
    // 4. Respaldo
    const status = err.status || 502;
    if (stored) return json({ ...stored, source: "d1", stale: true, upstreamStatus: status }, 200, 60);
    const stale = await cache.match(staleKey);
    if (stale) return json({ ...(await stale.json()), stale: true, upstreamStatus: status }, 200, 60);
    return json(
      {
        error:
          status === 429
            ? "La API de Sunflower Land limita la cantidad de consultas y todavía no hay una copia guardada"
            : `La API de Sunflower Land respondió ${status}`,
        hint:
          status === 429
            ? "Esperá unos minutos y volvé a intentar."
            : status === 401 || status === 403
              ? "Revisá que SFL_API_KEY esté cargada en Cloudflare y que tu granja siga teniendo VIP."
              : "Revisá el ID de granja o el endpoint (SFL_FARM_PATH).",
        retryAfter: err.retryAfter || null,
      },
      status
    );
  }
}

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
