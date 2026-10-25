// GET /api/history?farm=441
// Lee el historial que guarda el Worker programado en D1 y devuelve datos ya resumidos:
//   - days: una fila por día con coins, FLOWER y contadores de actividad
//   - priceStats: precio actual, promedio, mínimo y máximo de 7 días por recurso
//   - flowerSeries: precio de FLOWER cada ~4 horas (14 días)
//   - sales: ventas cobradas en el Marketplace (60 días)
//   - cron: estado del Worker
export async function onRequestGet({ env, request }) {
  const db = env.DB;
  if (!db) return json({ error: "La base D1 no está conectada a la web.", setup: true }, 501);

  const url = new URL(request.url);
  const id = Number(url.searchParams.get("farm")) || 441;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  const [snaps, prices, sales, meta, timers] = await Promise.all([
    db.prepare("SELECT day, taken_at, coins, flower, activity FROM snapshots WHERE farm_id = ? ORDER BY day DESC LIMIT 35").bind(id).all(),
    db.prepare("SELECT taken_at, flower_usd, prices FROM prices WHERE taken_at >= ? ORDER BY taken_at").bind(iso(now - 14 * 86400e3)).all(),
    db.prepare("SELECT id, fulfilled_at, items, flower, tax FROM sales WHERE farm_id = ? AND fulfilled_at >= ? ORDER BY fulfilled_at DESC").bind(id, now - 60 * 86400e3).all(),
    db.prepare("SELECT key, value FROM meta").all(),
    db.prepare("SELECT label, ready_at, notified FROM timers WHERE farm_id = ? AND ready_at >= ? ORDER BY ready_at LIMIT 30").bind(id, now - 3600e3).all(),
  ]);

  const days = (snaps.results || [])
    .map((r) => ({ day: r.day, takenAt: r.taken_at, coins: r.coins, flower: r.flower, activity: safe(r.activity) }))
    .reverse();

  // Estadísticas de precio de 7 días.
  const rows = (prices.results || []).map((r) => ({ t: Date.parse(r.taken_at), usd: r.flower_usd, p: safe(r.prices) }));
  const weekRows = rows.filter((r) => r.t >= now - 7 * 86400e3);
  const priceStats = {};
  for (const r of weekRows) {
    for (const [k, v] of Object.entries(r.p)) {
      const s = (priceStats[k] ||= { sum: 0, n: 0, min: Infinity, max: -Infinity, current: v });
      s.sum += v;
      s.n++;
      s.min = Math.min(s.min, v);
      s.max = Math.max(s.max, v);
      s.current = v;
    }
  }
  for (const k in priceStats) {
    const s = priceStats[k];
    priceStats[k] = { current: s.current, avg: s.sum / s.n, min: s.min, max: s.max, samples: s.n };
  }

  // Serie de FLOWER cada ~4 h.
  const flowerSeries = [];
  let lastT = 0;
  for (const r of rows) {
    if (r.usd && r.t - lastT >= 4 * 3600e3) {
      flowerSeries.push({ t: r.t, usd: r.usd });
      lastT = r.t;
    }
  }

  return json({
    days,
    priceStats,
    flowerSeries,
    sales: (sales.results || []).map((s) => ({ id: s.id, at: s.fulfilled_at, items: safe(s.items), flower: s.flower, tax: s.tax })),
    timers: (timers.results || []).map((t) => ({ label: t.label, readyAt: t.ready_at, notified: !!t.notified })),
    cron: Object.fromEntries((meta.results || []).map((m) => [m.key, m.value])),
  });
}

function safe(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
}
