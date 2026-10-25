// GET /api/market
// Precios piso del Marketplace (sfl.world), FLOWER/USD (DexScreener) y dólar cripto (dolarapi.com).
// Cachea 10 minutos en el edge.
import { fetchMarket } from "../../shared/sfl.js";

const CACHE_SECONDS = 600;

export async function onRequestGet({ env, request, waitUntil }) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/__cache/market", request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const body = await fetchMarket(env);
  const out = new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
      "access-control-allow-origin": "*",
    },
  });
  if (!body.errors.length) waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}
