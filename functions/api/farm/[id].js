// GET /api/farm/:id
// Con la base D1 conectada, la web SOLO lee de la base: el Worker programado es el único
// que consulta la API de Sunflower Land, así no compiten por el límite de consultas.
// La web consulta la API directo solo si la base todavía no tiene ninguna foto de la granja
// (o si no hay base conectada). En ese caso usa caché de 5 minutos y respaldo ante 429.
import { fetchFarmUpstream, readLatestFarm, writeLatestFarm, storeFarm, farmOf } from "../../../shared/sfl.js";

const TZ = "America/Argentina/Buenos_Aires";
const MANUAL_MIN_GAP_MS = 90e3; // el botón "Actualizar" no consulta la API más de una vez cada 90 s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STALE_SECONDS = 86400;

export async function onRequestGet({ params, env, request, waitUntil }) {
  const id = String(params.id || "").replace(/\D/g, "");
  if (!id) return json({ error: "El ID de granja tiene que ser numérico." }, 400);

  const db = env.DB || null;
  const fresh = Number(env.FARM_CACHE_SECONDS) || 300;
  const dbMaxAge = (Number(env.FARM_DB_MAX_AGE_MIN) || 35) * 60e3;

  const stored = await readLatestFarm(db, id).catch(() => null);

  // 0. ?fresh=1 (botón "Actualizar"): consulta la API en el momento, con hasta 3 intentos rápidos ante un 429.
  if (db && new URL(request.url).searchParams.get("fresh") === "1") {
    const last = await db.prepare("SELECT value FROM meta WHERE key = 'manualFetchAt'").first().catch(() => null);
    const wait = MANUAL_MIN_GAP_MS - (Date.now() - Number(last?.value || 0));
    if (wait > 0) {
      return json({ ...(stored || {}), source: "d1", stale: true, manual: { ok: false, reason: "pronto", waitS: Math.ceil(wait / 1000) } }, 200);
    }
    await db.prepare("INSERT INTO meta (key, value) VALUES ('manualFetchAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(Date.now())).run();
    let lastErr = null;
    for (const delay of [0, 1500, 4000]) {
      if (delay) await sleep(delay);
      try {
        const data = await fetchFarmUpstream(env, id);
        const fetchedAt = await storeFarm(db, id, data, env.TIMEZONE || TZ, "botón");
        return json({ fetchedAt, source: "api", data, manual: { ok: true } }, 200);
      } catch (err) {
        lastErr = err;
        if (err.status !== 429) break;
      }
    }
    return json({ ...(stored || {}), source: "d1", stale: true, manual: { ok: false, reason: lastErr?.status === 429 ? "limite" : "error", detail: String(lastErr?.message || "").slice(0, 200) } }, 200);
  }

  // 1. D1: si hay foto, se usa siempre. Si es vieja, se marca "stale" pero no se consulta la API.
  if (stored) {
    const old = Date.now() - Date.parse(stored.fetchedAt) >= dbMaxAge;
    return json({ ...stored, source: "d1", ...(old ? { stale: true } : {}) }, 200, 60);
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

// POST /api/farm/:id — la web sube una granja leída directamente desde el navegador.
// Protegido con la clave de sincronización (x-sync-key = SYNC_KEY).
export async function onRequestPost({ params, env, request }) {
  const id = String(params.id || "").replace(/\D/g, "");
  if (!env.DB) return json({ error: "La base D1 no está conectada." }, 501);
  if (!env.SYNC_KEY || request.headers.get("x-sync-key") !== env.SYNC_KEY) return json({ error: "Clave de sincronización incorrecta." }, 401);
  const body = await request.json().catch(() => null);
  const data = body?.data;
  const farm = farmOf(data);
  // Controles básicos: que sea una granja y que sea la misma.
  if (!farm || typeof farm !== "object" || !farm.inventory) return json({ error: "No parece una granja de Sunflower Land." }, 400);
  if (data?.id && String(data.id) !== id) return json({ error: "El número de granja no coincide." }, 400);
  const text = JSON.stringify(data);
  if (text.length > 4_000_000) return json({ error: "Los datos son demasiado grandes." }, 413);
  const fetchedAt = await storeFarm(env.DB, id, data, env.TIMEZONE || TZ, "navegador");
  return json({ ok: true, fetchedAt });
}
