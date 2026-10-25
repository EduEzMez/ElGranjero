// GET /api/farm/:id
// Proxy hacia la Community API de Sunflower Land.
// - Caché "fresca" de 5 minutos: todas las visitas en ese lapso no tocan la API.
// - Copia de respaldo de 24 horas: si la API responde 429 (límite de consultas)
//   o falla, se devuelve la última respuesta buena marcada como "stale".
//
// Variables de entorno opcionales:
//   SFL_API_BASE   por defecto https://api.sunflower-land.com
//   SFL_FARM_PATH  por defecto /community/farms/{id}
//   SFL_API_KEY    key de la Community API, se envía como x-api-key
//   FARM_CACHE_SECONDS  por defecto 300

const STALE_SECONDS = 86400;

export async function onRequestGet({ params, env, request, waitUntil }) {
  const id = String(params.id || "").replace(/\D/g, "");
  if (!id) return json({ error: "El ID de granja tiene que ser numérico." }, 400);

  const fresh = Number(env.FARM_CACHE_SECONDS) || 300;
  const base = (env.SFL_API_BASE || "https://api.sunflower-land.com").replace(/\/$/, "");
  const path = (env.SFL_FARM_PATH || "/community/farms/{id}").replace("{id}", id);
  const upstream = base + path;

  const cache = caches.default;
  const freshKey = new Request(new URL(`/__cache/farm/${id}`, request.url).toString());
  const staleKey = new Request(new URL(`/__cache/farm-stale/${id}`, request.url).toString());

  const hit = await cache.match(freshKey);
  if (hit) return hit;

  const headers = { accept: "application/json", "user-agent": "DonGranjero/1.0" };
  if (env.SFL_API_KEY) headers["x-api-key"] = env.SFL_API_KEY;

  let res = null;
  let networkError = null;
  try {
    res = await fetch(upstream, { headers });
  } catch (err) {
    networkError = String(err);
  }

  if (res && res.ok) {
    const data = await res.json();
    const body = { fetchedAt: new Date().toISOString(), source: upstream, data };
    const out = json(body, 200, fresh);
    waitUntil(cache.put(freshKey, out.clone()));
    waitUntil(cache.put(staleKey, json(body, 200, STALE_SECONDS)));
    return out;
  }

  // Falló: probar con la última copia buena.
  const status = res ? res.status : 502;
  const retryAfter = res?.headers.get("retry-after") || null;
  const stale = await cache.match(staleKey);
  if (stale) {
    const body = await stale.json();
    return json({ ...body, stale: true, upstreamStatus: status, retryAfter }, 200, 60);
  }

  const text = res ? await res.text().catch(() => "") : networkError;
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
      retryAfter,
      detail: String(text || "").slice(0, 300),
    },
    status
  );
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
