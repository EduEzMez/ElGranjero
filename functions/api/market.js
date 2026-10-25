// GET /api/market
// Junta dos fuentes y las normaliza:
//   1) Precios piso del Marketplace (P2P) por recurso, en FLOWER  -> sfl.world
//   2) Precio FLOWER/USD (par con más liquidez en Base)           -> DexScreener
// Cachea 10 minutos en el edge.
//
// Variables de entorno opcionales:
//   PRICES_URL     por defecto https://sfl.world/api/v1/prices
//   FLOWER_TOKEN   por defecto 0x3e12b9d6a4d12cd9b4a6d613872d0eb32f68b380 (FLOWER en Base)

const CACHE_SECONDS = 600;

export async function onRequestGet({ env, request, waitUntil }) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/__cache/market", request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const pricesUrl = env.PRICES_URL || "https://sfl.world/api/v1/prices";
  const token = (env.FLOWER_TOKEN || "0x3e12b9d6a4d12cd9b4a6d613872d0eb32f68b380").toLowerCase();

  const [pricesRes, dexRes, arsRes] = await Promise.allSettled([
    getJson(pricesUrl),
    getJson(`https://api.dexscreener.com/latest/dex/tokens/${token}`),
    getJson(env.ARS_URL || "https://dolarapi.com/v1/dolares/cripto"),
  ]);

  const errors = [];
  let prices = {};
  let pricesUpdatedAt = null;
  if (pricesRes.status === "fulfilled") {
    const raw = pricesRes.value;
    const root = raw?.data ?? raw;
    // sfl.world expone varios mercados; p2p = piso del Marketplace del juego.
    prices = cleanPrices(root?.p2p ?? root?.prices ?? root ?? {});
    pricesUpdatedAt = root?.updatedAt ?? raw?.updatedAt ?? null;
  } else {
    errors.push({ source: "prices", message: String(pricesRes.reason) });
  }

  let flowerUsd = null;
  let flowerPair = null;
  if (dexRes.status === "fulfilled") {
    const pairs = (dexRes.value?.pairs || []).filter(
      (p) => p?.baseToken?.address?.toLowerCase() === token && Number(p.priceUsd) > 0
    );
    pairs.sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0));
    if (pairs[0]) {
      flowerUsd = Number(pairs[0].priceUsd);
      flowerPair = {
        dex: pairs[0].dexId,
        chain: pairs[0].chainId,
        liquidityUsd: pairs[0]?.liquidity?.usd ?? null,
        volume24hUsd: pairs[0]?.volume?.h24 ?? null,
        change24h: pairs[0]?.priceChange?.h24 ?? null,
      };
    } else {
      errors.push({ source: "flower", message: "No se encontró un par con precio para FLOWER." });
    }
  } else {
    errors.push({ source: "flower", message: String(dexRes.reason) });
  }

  // Dólar cripto: "compra" es lo que te pagan en pesos por cada dólar (USDT) que vendés.
  let ars = null;
  if (arsRes.status === "fulfilled" && Number(arsRes.value?.compra) > 0) {
    ars = { compra: Number(arsRes.value.compra), venta: Number(arsRes.value.venta) || null, nombre: arsRes.value.nombre || "Cripto", fecha: arsRes.value.fechaActualizacion || null };
  }

  const out = new Response(
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      pricesUpdatedAt,
      prices,
      flowerUsd,
      flowerPair,
      ars,
      errors,
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_SECONDS}`,
        "access-control-allow-origin": "*",
      },
    }
  );
  if (!errors.length) waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "DonGranjero/1.0" } });
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  return res.json();
}

function cleanPrices(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}
