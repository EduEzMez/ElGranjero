// GET /api/farm/:id
// Proxy hacia la Community API de Sunflower Land.
// Evita CORS, permite usar una API key opcional y cachea 2 minutos en el edge.
//
// Variables de entorno opcionales (Cloudflare Pages > Settings > Environment variables):
//   SFL_API_BASE   por defecto https://api.sunflower-land.com
//   SFL_FARM_PATH  por defecto /community/farms/{id}
//   SFL_API_KEY    si la API te exige una key, se envía como x-api-key

const CACHE_SECONDS = 120;

export async function onRequestGet({ params, env, request, waitUntil }) {
  const id = String(params.id || "").replace(/\D/g, "");
  if (!id) return json({ error: "El ID de granja tiene que ser numérico." }, 400);

  const base = (env.SFL_API_BASE || "https://api.sunflower-land.com").replace(/\/$/, "");
  const path = (env.SFL_FARM_PATH || "/community/farms/{id}").replace("{id}", id);
  const upstream = base + path;

  const cache = caches.default;
  const cacheKey = new Request(new URL(`/__cache/farm/${id}`, request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const headers = { accept: "application/json", "user-agent": "DonGranjero/1.0" };
  if (env.SFL_API_KEY) headers["x-api-key"] = env.SFL_API_KEY;

  let res;
  try {
    res = await fetch(upstream, { headers });
  } catch (err) {
    return json({ error: "No se pudo contactar la API de Sunflower Land.", detail: String(err) }, 502);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return json(
      {
        error: `La API de Sunflower Land respondió ${res.status}.`,
        hint:
          res.status === 401 || res.status === 403
            ? "Puede que haga falta una API key: cargala como SFL_API_KEY en Cloudflare."
            : "Revisá el ID de granja o el endpoint (SFL_FARM_PATH).",
        detail: text.slice(0, 300),
      },
      res.status
    );
  }

  const data = await res.json();
  const out = json({ fetchedAt: new Date().toISOString(), source: upstream, data }, 200, CACHE_SECONDS);
  waitUntil(cache.put(cacheKey, out.clone()));
  return out;
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
