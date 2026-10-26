// Código compartido entre la web (Pages Functions) y el Worker programado.
import { CROPS, FRUITS, NODES, LABELS } from "../public/js/data.js";

const UA = { accept: "application/json", "user-agent": "DonGranjero/1.0" };

export async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers } });
  if (!res.ok) {
    // Se guarda lo que explica la API (cuerpo y headers de límite) para poder diagnosticar un 429.
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    const limits = [...res.headers.entries()]
      .filter(([k]) => /^(retry-after|x-ratelimit)/i.test(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const err = new Error(`${url} respondió ${res.status}${body ? `: ${body}` : ""}${limits ? ` [${limits}]` : ""}`);
    err.status = res.status;
    err.retryAfter = res.headers.get("retry-after");
    throw err;
  }
  return res.json();
}

/* ---------- Granja ---------- */

export function farmUrl(env, id) {
  const base = (env.SFL_API_BASE || "https://api.sunflower-land.com").replace(/\/$/, "");
  return base + (env.SFL_FARM_PATH || "/community/farms/{id}").replace("{id}", id);
}

export async function fetchFarmUpstream(env, id) {
  const headers = env.SFL_API_KEY ? { "x-api-key": env.SFL_API_KEY } : {};
  return getJson(farmUrl(env, id), headers);
}

export const farmOf = (data) => data?.farm ?? data;

export async function readLatestFarm(db, id) {
  if (!db) return null;
  const row = await db.prepare("SELECT fetched_at, data FROM farm_latest WHERE farm_id = ?").bind(Number(id)).first();
  return row ? { fetchedAt: row.fetched_at, data: JSON.parse(row.data) } : null;
}

export async function writeLatestFarm(db, id, data, fetchedAt = new Date().toISOString()) {
  if (!db) return;
  await db
    .prepare("INSERT INTO farm_latest (farm_id, fetched_at, data) VALUES (?, ?, ?) ON CONFLICT(farm_id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data")
    .bind(Number(id), fetchedAt, JSON.stringify(data))
    .run();
}

/* ---------- Mercado ---------- */

export async function fetchMarket(env) {
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
    const root = pricesRes.value?.data ?? pricesRes.value;
    for (const [k, v] of Object.entries(root?.p2p ?? root?.prices ?? root ?? {})) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) prices[k] = n;
    }
    pricesUpdatedAt = root?.updatedAt ?? pricesRes.value?.updatedAt ?? null;
  } else errors.push({ source: "prices", message: String(pricesRes.reason?.message || pricesRes.reason) });

  // Todos los pools de FLOWER con liquidez real, y un promedio ponderado por liquidez.
  let flowerUsd = null;
  let flowerPair = null;
  let pools = [];
  const minLiq = Number(env.MIN_POOL_LIQUIDITY_USD) || 1000;
  if (dexRes.status === "fulfilled") {
    for (const p of dexRes.value?.pairs || []) {
      const base = p?.baseToken?.address?.toLowerCase();
      const quote = p?.quoteToken?.address?.toLowerCase();
      let price = null;
      if (base === token) price = Number(p.priceUsd);
      else if (quote === token && Number(p.priceNative) > 0) price = Number(p.priceUsd) / Number(p.priceNative); // FLOWER del lado cotizado
      if (!(price > 0)) continue;
      pools.push({
        id: p.pairAddress,
        dex: p.dexId,
        chain: p.chainId,
        pair: `${p.baseToken?.symbol || "?"}/${p.quoteToken?.symbol || "?"}`,
        priceUsd: price,
        liquidityUsd: Number(p?.liquidity?.usd) || 0,
        volume24hUsd: Number(p?.volume?.h24) || 0,
        change24h: p?.priceChange?.h24 ?? null,
        url: p.url || null,
      });
    }
    pools.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    const real = pools.filter((x) => x.liquidityUsd >= minLiq);
    const use = real.length ? real : pools.slice(0, 1);
    const wSum = use.reduce((a, x) => a + (x.liquidityUsd || 1), 0);
    if (use.length) {
      flowerUsd = use.reduce((a, x) => a + x.priceUsd * (x.liquidityUsd || 1), 0) / wSum;
      const top = use[0];
      flowerPair = {
        dex: top.dex,
        chain: top.chain,
        pools: use.length,
        liquidityUsd: use.reduce((a, x) => a + x.liquidityUsd, 0),
        volume24hUsd: use.reduce((a, x) => a + x.volume24hUsd, 0),
        change24h: top.change24h,
        method: use.length > 1 ? "promedio" : "pool",
      };
    } else errors.push({ source: "flower", message: "No se encontró un pool con precio para FLOWER." });
    pools = pools.slice(0, 8).map((x) => ({ ...x, used: x.liquidityUsd >= minLiq }));
  } else errors.push({ source: "flower", message: String(dexRes.reason?.message || dexRes.reason) });

  let ars = null;
  if (arsRes.status === "fulfilled" && Number(arsRes.value?.compra) > 0) {
    ars = {
      compra: Number(arsRes.value.compra),
      venta: Number(arsRes.value.venta) || null,
      nombre: arsRes.value.nombre || "Cripto",
      fecha: arsRes.value.fechaActualizacion || null,
    };
  }

  return { fetchedAt: new Date().toISOString(), pricesUpdatedAt, prices, flowerUsd, flowerPair, pools, ars, errors };
}

/* ---------- Historial ---------- */

// Contadores de actividad que vale la pena guardar.
const COUNTER_RE = / (Harvested|Mined|Chopped|Collected|Caught|Drilled|Dug|Casted|Fed|Delivered)$/;
const COUNTER_KEYS = new Set([
  "SFL Earned", "SFL Spent", "FLOWER Spent", "Coins Earned", "Coins Spent",
  "Marketplace FLOWER Fee", "FLOWER Withdrawn", "FLOWER Deposited", "Rod Casted",
]);
export function pickActivity(activity = {}) {
  const out = {};
  for (const [k, v] of Object.entries(activity)) {
    const n = Number(v);
    if (Number.isFinite(n) && (COUNTER_KEYS.has(k) || COUNTER_RE.test(k))) out[k] = n;
  }
  return out;
}

export function dayIn(tz, date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export async function saveSnapshot(db, id, farm, tz) {
  const inventory = {};
  for (const [k, v] of Object.entries(farm.inventory || {})) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) inventory[k] = n;
  }
  await db
    .prepare(
      `INSERT INTO snapshots (farm_id, day, taken_at, coins, flower, activity, inventory) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(farm_id, day) DO UPDATE SET taken_at = excluded.taken_at, coins = excluded.coins, flower = excluded.flower,
       activity = excluded.activity, inventory = excluded.inventory`
    )
    .bind(Number(id), dayIn(tz), new Date().toISOString(), Number(farm.coins) || 0, Number(farm.balance) || 0, JSON.stringify(pickActivity(farm.farmActivity)), JSON.stringify(inventory))
    .run();
}

export async function saveSales(db, id, farm) {
  const stmts = [];
  for (const [lid, l] of Object.entries(farm.trades?.listings || {})) {
    if (!l?.fulfilledAt) continue;
    stmts.push(
      db
        .prepare("INSERT OR IGNORE INTO sales (id, farm_id, fulfilled_at, items, flower, tax) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(lid, Number(id), Number(l.fulfilledAt), JSON.stringify(l.items || {}), Number(l.sfl) || 0, Number(l.tax) || 0)
    );
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

/* ---------- Timers para avisos ---------- */

const hoursOf = Object.fromEntries([...CROPS, ...FRUITS, ...NODES].map((x) => [x.name, x.hours]));
const live = (o) => Object.values(o || {}).filter((n) => n && typeof n === "object" && !n.removedAt);
const lbl = (n) => LABELS[n] || n;

// Devuelve grupos { key, label, readyAt } (nodos del mismo tipo listos con menos de 10 min de diferencia).
const hhmm = (ms, tz) => new Intl.DateTimeFormat("es-AR", { timeZone: tz || "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

export function computeTimers(farm, tz) {
  const events = [];
  const push = (kind, name, readyAt) => Number.isFinite(readyAt) && readyAt > 0 && events.push({ kind, name, readyAt });

  for (const p of live(farm.crops)) {
    const c = p.crop;
    if (c?.name && hoursOf[c.name]) push("crop", c.name, c.plantedAt + hoursOf[c.name] * 3600e3 - (c.boostedTime || 0));
  }
  for (const p of live(farm.fruitPatches)) {
    const fr = p.fruit;
    if (!fr?.name || !hoursOf[fr.name] || fr.harvestsLeft === 0) continue;
    const from = fr.harvestedAt > 0 ? fr.harvestedAt : fr.plantedAt;
    push("fruit", fr.name, from + hoursOf[fr.name] * 3600e3 - (fr.boostedTime || 0));
  }
  for (const [key, name] of [["stones", "Stone"], ["iron", "Iron"], ["gold", "Gold"], ["crimstones", "Crimstone"]]) {
    for (const n of live(farm[key])) if (n.stone?.minedAt) push("node", name, n.stone.minedAt + hoursOf[name] * 3600e3 - (n.stone.boostedTime || 0));
  }
  for (const t of live(farm.trees)) if (t.wood?.choppedAt) push("node", "Wood", t.wood.choppedAt + hoursOf.Wood * 3600e3 - (t.wood.boostedTime || 0));
  for (const o of live(farm.oilReserves)) if (o.oil?.drilledAt) push("node", "Oil", o.oil.drilledAt + hoursOf.Oil * 3600e3 - (o.oil.boostedTime || 0));
  for (const a of [...live(farm.henHouse?.animals), ...live(farm.barn?.animals)]) {
    if (a.awakeAt) push("animal", a.type, a.awakeAt);
  }
  for (const [bname, list] of Object.entries(farm.buildings || {})) {
    for (const b of list || []) if (b?.producing?.readyAt && !b.removedAt) push("building", bname, b.producing.readyAt);
  }

  events.sort((a, b) => a.readyAt - b.readyAt);

  // Isla flotante: aviso unos minutos antes de cada apertura del horario que trae la granja.
  const islandLead = 5 * 60e3;
  const island = (farm.floatingIsland?.schedule || [])
    .filter((w) => Number(w?.startAt) > 0 && Number(w?.endAt) > Date.now())
    .map((w) => ({
      // La hora de cierre va en la clave para no avisar una isla que ya cerró.
      key: `island:${w.startAt}:${w.endAt}`,
      label: `🏝️ La isla flotante abre a las ${hhmm(w.startAt, tz)} y cierra a las ${hhmm(w.endAt, tz)}`,
      readyAt: Math.round(Number(w.startAt) - islandLead),
    }));
  const groups = [];
  for (const e of events) {
    const g = groups.find((x) => x.kind === e.kind && x.name === e.name && e.readyAt - x.first <= 10 * 60e3);
    if (g) {
      g.count++;
      g.readyAt = e.readyAt;
    } else groups.push({ kind: e.kind, name: e.name, first: e.readyAt, readyAt: e.readyAt, count: 1 });
  }
  const noun = { crop: "parcelas de", fruit: "parches de", node: "", animal: "", building: "" };
  const animalName = { Chicken: "gallinas", Cow: "vacas", Sheep: "ovejas" };
  return [...island, ...groups.map((g) => {
    let label;
    if (g.kind === "animal") label = `${g.count} ${animalName[g.name] || g.name} despiertas`;
    else if (g.kind === "building") label = `${g.name}: producción lista`;
    else if (g.kind === "node") label = `${g.count} × ${lbl(g.name)}`;
    else label = `${g.count} ${noun[g.kind]} ${lbl(g.name)}`;
    return { key: `${g.kind}:${g.name}:${Math.round(g.first / 60e3)}`, label, readyAt: Math.round(g.readyAt) };
  })];
}

export async function saveTimers(db, id, timers) {
  const now = Date.now();
  // Se reemplazan los pendientes futuros; los ya avisados se conservan para no repetir.
  const stmts = [db.prepare("DELETE FROM timers WHERE farm_id = ? AND notified = 0").bind(Number(id))];
  for (const t of timers) {
    if (t.readyAt < now - 12 * 3600e3) continue;
    stmts.push(db.prepare("INSERT OR IGNORE INTO timers (farm_id, key, label, ready_at, notified) VALUES (?, ?, ?, ?, 0)").bind(Number(id), t.key, t.label, t.readyAt));
  }
  stmts.push(db.prepare("DELETE FROM timers WHERE farm_id = ? AND ready_at < ?").bind(Number(id), now - 3 * 86400e3));
  await db.batch(stmts);
}
