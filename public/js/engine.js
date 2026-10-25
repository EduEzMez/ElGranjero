// Motor de rentabilidad de DonGranjero.
// Todo se expresa en FLOWER neto por día y después se convierte a USD.
import { CROPS, FRUITS, NODES, ANIMALS, BOOSTS, SEASON_CROPS, LABELS } from "./data.js";

const WARM_DAYS = 7; // días de "arranque" que se descartan para medir un régimen estable
const MEASURE_DAYS = 7;
const PLOT_DAYS = 30; // horizonte de la optimización de parcelas

/* ---------- Lectura de la granja ---------- */

export function detectFarm(raw) {
  if (!raw) return null;
  const f = raw.farm ?? raw.data?.farm ?? raw.data ?? raw;
  const n = (o) => (o && typeof o === "object" ? Object.keys(o).length : 0);
  const animals = [
    ...Object.values(f.henHouse?.animals || {}),
    ...Object.values(f.barn?.animals || {}),
  ];
  const ofType = (t) => animals.filter((a) => a?.type === t).length;

  const placed = new Set([
    ...Object.keys(f.collectibles || {}),
    ...Object.keys(f.home?.collectibles || {}),
  ]);
  const wearables = new Set(
    Object.values(f.bumpkin?.equipped || {})
      .flat()
      .filter((v) => typeof v === "string")
  );
  const skills = new Set(Object.keys(f.bumpkin?.skills || {}));

  return {
    counts: {
      crops: n(f.crops),
      fruits: n(f.fruitPatches),
      Wood: n(f.trees),
      Stone: n(f.stones),
      Iron: n(f.iron),
      Gold: n(f.gold),
      Crimstone: n(f.crimstones),
      Oil: n(f.oilReserves),
      Egg: ofType("Chicken") || n(f.chickens),
      Milk: ofType("Cow"),
      Wool: ofType("Sheep"),
    },
    placed,
    wearables,
    skills,
    season: f.season?.season ?? null,
    island: f.island?.type ?? null,
    coins: Number(f.coins) || 0,
    flower: Number(f.balance) || 0,
    username: f.username ?? null,
  };
}

/* ---------- Sesiones de juego ---------- */

export function sessionTimes(cfg) {
  const n = Math.max(1, Math.round(cfg.sessions));
  const a = cfg.firstHour * 60;
  const b = Math.max(cfg.lastHour * 60, a);
  if (n === 1) return [a];
  const step = (b - a) / (n - 1);
  return Array.from({ length: n }, (_, i) => Math.round(a + i * step));
}

function timeline(cfg, days = WARM_DAYS + MEASURE_DAYS + 1) {
  const day = sessionTimes(cfg);
  const out = [];
  for (let d = 0; d < days; d++) for (const m of day) out.push(d * 1440 + m);
  return out;
}

const measuring = (t) => t >= WARM_DAYS * 1440 && t < (WARM_DAYS + MEASURE_DAYS) * 1440;

// Nodo que se repone solo: cosechás en la primera sesión en que está listo.
function harvestsPerDay(cycleMin, tl) {
  let ready = tl[0] + cycleMin;
  let n = 0;
  for (const s of tl.slice(1)) {
    if (s >= ready) {
      if (measuring(s)) n++;
      ready = s + cycleMin;
    }
  }
  return n / MEASURE_DAYS;
}

// Parcela con elección libre de cultivo.
// Programación dinámica sobre tus sesiones: en cada sesión decide qué plantar
// (o dejar vacío) para maximizar el FLOWER total, sabiendo que solo cosechás
// cuando entrás al juego. Como todas las parcelas son iguales, se resuelve una
// y se multiplica.
function optimalPlot(options, tl) {
  const N = tl.length;
  const nextIdx = options.map((o) => {
    const arr = new Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const t = tl[i] + o.cycleMin;
      if (j <= i) j = i + 1;
      while (j < N && tl[j] < t) j++;
      arr[i] = j;
    }
    return arr;
  });
  const tEnd = PLOT_DAYS * 1440;
  // Lo que queda plantado al final del horizonte se valúa proporcionalmente,
  // así los cultivos largos no quedan castigados por el corte.
  const tail = (o, i) => o.value * Math.min(1, Math.max(0, tEnd - tl[i]) / o.cycleMin);
  const V = new Float64Array(N + 1);
  const pick = new Int16Array(N).fill(-1);
  for (let i = N - 1; i >= 0; i--) {
    let best = V[i + 1];
    let ch = -1;
    options.forEach((o, k) => {
      if (o.value <= 0) return;
      const j = nextIdx[k][i];
      const v = j >= N ? tail(o, i) : o.value + V[j];
      if (v > best + 1e-12) {
        best = v;
        ch = k;
      }
    });
    V[i] = best;
    pick[i] = ch;
  }

  const counts = Object.fromEntries(options.map((o) => [o.name, 0]));
  const plan = [];
  const planStart = WARM_DAYS * 1440;
  const planEnd = planStart + 2 * 1440;
  let i = 0;
  while (i < N) {
    const k = pick[i];
    if (k < 0) {
      i++;
      continue;
    }
    const o = options[k];
    const j = nextIdx[k][i];
    if (tl[i] >= planStart && tl[i] < planEnd) {
      plan.push({ minute: tl[i] - planStart, crop: o.name, readyMinute: (j < N ? tl[j] : tl[i] + o.cycleMin) - planStart });
    }
    counts[o.name] += j >= N ? tail(o, i) / o.value : 1;
    i = j;
  }
  for (const key in counts) counts[key] /= PLOT_DAYS;
  return { counts, plan };
}

/* ---------- Boosts ---------- */

export function activeBoosts(detected, state, extra = []) {
  const disabled = new Set(state.disabledBoosts || []);
  const list = [];
  if (detected) {
    for (const b of BOOSTS) {
      if (disabled.has(b.name)) continue;
      const has =
        (b.type === "collectible" && detected.placed.has(b.name)) ||
        (b.type === "wearable" && detected.wearables.has(b.name)) ||
        (b.type === "skill" && detected.skills.has(b.name));
      if (has) list.push({ ...b, source: "auto" });
    }
  }
  for (const b of state.customBoosts || []) if (!disabled.has(b.name)) list.push({ ...b, source: "manual" });
  for (const b of extra) list.push({ ...b, source: "simulado" });

  // Boosts del mismo grupo no se acumulan: queda el más fuerte.
  const score = (b) => (b.yieldPct || 0) + (b.yieldAdd || 0) * 100 - (b.timePct || 0);
  const byGroup = new Map();
  const out = [];
  for (const b of list) {
    if (!b.group) {
      out.push(b);
      continue;
    }
    const prev = byGroup.get(b.group);
    if (!prev || score(b) > score(prev)) byGroup.set(b.group, b);
  }
  return [...out, ...byGroup.values()];
}

function modsFor(name, group, boosts) {
  let yieldPct = 0;
  let yieldAdd = 0;
  let timeMult = 1;
  const applied = [];
  for (const b of boosts) {
    const t = b.targets || [];
    if (!t.includes(name) && !t.includes(group) && !t.includes("all")) continue;
    yieldPct += b.yieldPct || 0;
    yieldAdd += b.yieldAdd || 0;
    if (b.timePct) timeMult *= 1 + b.timePct / 100;
    applied.push(b.name);
  }
  return { yieldPct, yieldAdd, timeMult: Math.max(0.05, timeMult), applied };
}

/* ---------- Cálculo principal ---------- */

export function compute({ state, detected, market, extraBoosts = [], sessionsOverride = null }) {
  const cfg = sessionsOverride ? { ...state, sessions: sessionsOverride } : state;
  const tl = timeline(cfg);
  const boosts = activeBoosts(detected, state, extraBoosts);
  const fee = 1 - (state.marketFee || 0) / 100;
  const coin = Number(state.coinToFlower) || 0;
  const excluded = new Set(state.excluded || []);

  const price = (name) => {
    const o = state.priceOverrides?.[name];
    if (o !== undefined && o !== null && o !== "" && Number(o) >= 0) return Number(o);
    const m = market?.prices?.[name];
    return Number.isFinite(m) ? m : null;
  };
  const count = (key) => {
    const o = state.countOverrides?.[key];
    if (o !== undefined && o !== null && o !== "") return Math.max(0, Number(o) || 0);
    return detected?.counts?.[key] ?? 0;
  };

  const streams = [];
  const missingPrices = new Set();

  /* Cultivos */
  const plots = count("crops");
  const season = detected?.season;
  const enabled = new Set(
    state.enabledCrops ?? (season && SEASON_CROPS[season] ? SEASON_CROPS[season] : CROPS.map((c) => c.name))
  );
  const cropOptions = [];
  for (const c of CROPS) {
    if (!enabled.has(c.name) || excluded.has(c.name)) continue;
    const p = price(c.name);
    if (p === null) {
      missingPrices.add(c.name);
      continue;
    }
    const m = modsFor(c.name, "crops", boosts);
    const yld = (1 + m.yieldAdd) * (1 + m.yieldPct / 100);
    cropOptions.push({
      name: c.name,
      cycleMin: c.hours * 60 * m.timeMult,
      yield: yld,
      price: p,
      seed: c.seed,
      value: yld * p * fee - c.seed * coin,
      applied: m.applied,
    });
  }

  const plotTl = timeline(cfg, PLOT_DAYS + 1).filter((t) => t < PLOT_DAYS * 1440);
  const singleCrop = cropOptions
    .map((o) => {
      const h = optimalPlot([o], plotTl).counts[o.name];
      return {
        name: o.name,
        harvestsPerPlot: h,
        unitsDay: h * o.yield * plots,
        netFlowerDay: h * o.value * plots,
        cycleMin: o.cycleMin,
        price: o.price,
        applied: o.applied,
      };
    })
    .sort((a, b) => b.netFlowerDay - a.netFlowerDay);

  let plan = [];
  if (plots > 0 && cropOptions.length) {
    const g = optimalPlot(cropOptions, plotTl);
    plan = g.plan;
    for (const o of cropOptions) {
      const h = g.counts[o.name];
      if (!h) continue;
      const units = h * o.yield * plots;
      streams.push({
        name: o.name,
        category: "crop",
        nodes: plots,
        unitsDay: units,
        price: o.price,
        grossFlowerDay: units * o.price * fee,
        costFlowerDay: h * plots * o.seed * coin,
        coinsDay: h * plots * o.seed,
        netFlowerDay: h * plots * o.value,
        cycleMin: o.cycleMin,
        applied: o.applied,
        detail: `${fmt(h, 2)} cosechas por parcela al día`,
      });
    }
  }

  /* Frutas: se elige una sola fruta para todos los parches */
  const patches = count("fruits");
  const fruitRank = [];
  for (const fr of FRUITS) {
    if (excluded.has(fr.name)) continue;
    const p = price(fr.name);
    if (p === null) {
      missingPrices.add(fr.name);
      continue;
    }
    const m = modsFor(fr.name, "fruits", boosts);
    const yld = (1 + m.yieldAdd) * (1 + m.yieldPct / 100);
    const cycleMin = fr.hours * 60 * m.timeMult;
    const h = harvestsPerDay(cycleMin, tl);
    const seedPerHarvest = fr.seed / fr.harvests;
    const units = h * yld * patches;
    fruitRank.push({
      name: fr.name,
      category: "fruit",
      nodes: patches,
      unitsDay: units,
      price: p,
      grossFlowerDay: units * p * fee,
      costFlowerDay: h * patches * seedPerHarvest * coin,
      coinsDay: h * patches * seedPerHarvest,
      netFlowerDay: units * p * fee - h * patches * seedPerHarvest * coin,
      cycleMin,
      applied: m.applied,
      detail: `${fmt(h, 2)} cosechas por parche al día`,
    });
  }
  fruitRank.sort((a, b) => b.netFlowerDay - a.netFlowerDay);
  if (patches > 0 && fruitRank[0]) streams.push({ ...fruitRank[0], bestOf: fruitRank.length });

  /* Nodos: madera, minerales, petróleo */
  for (const nd of NODES) {
    const k = count(nd.countKey);
    if (!k || excluded.has(nd.name)) continue;
    const p = price(nd.name);
    if (p === null) {
      missingPrices.add(nd.name);
      continue;
    }
    const m = modsFor(nd.name, "nodes", boosts);
    const yld = ((nd.baseYield || 1) + m.yieldAdd) * (1 + m.yieldPct / 100);
    const cycleMin = nd.hours * 60 * m.timeMult;
    const h = harvestsPerDay(cycleMin, tl);
    let matCost = 0;
    const unknownMats = [];
    for (const [item, qty] of Object.entries(nd.tool.items)) {
      const ip = price(item);
      if (ip === null) unknownMats.push(item);
      else matCost += qty * ip;
    }
    const perHit = nd.tool.coins * coin + matCost;
    const units = h * yld * k;
    streams.push({
      name: nd.name,
      category: "node",
      nodes: k,
      unitsDay: units,
      price: p,
      grossFlowerDay: units * p * fee,
      costFlowerDay: h * k * perHit,
      coinsDay: h * k * nd.tool.coins,
      netFlowerDay: units * p * fee - h * k * perHit,
      cycleMin,
      applied: m.applied,
      detail: `${nd.tool.name} por golpe`,
      unknownMats,
    });
  }

  /* Animales */
  for (const an of ANIMALS) {
    const k = count(an.countKey);
    if (!k || excluded.has(an.name)) continue;
    const p = price(an.name);
    if (p === null) {
      missingPrices.add(an.name);
      continue;
    }
    const cfgA = { ...an, ...(state.animalCfg?.[an.name] || {}) };
    const m = modsFor(an.name, "animals", boosts);
    const units = k * Number(cfgA.perDay) * (1 + m.yieldPct / 100) + k * m.yieldAdd;
    const fp = price(cfgA.feedItem);
    const feedCost = fp === null ? 0 : k * Number(cfgA.feedQty) * fp;
    streams.push({
      name: an.name,
      category: "animal",
      nodes: k,
      unitsDay: units,
      price: p,
      grossFlowerDay: units * p * fee,
      costFlowerDay: feedCost,
      coinsDay: 0,
      netFlowerDay: units * p * fee - feedCost,
      cycleMin: 1440,
      applied: m.applied,
      detail: `alimento: ${cfgA.feedQty} ${LABELS[cfgA.feedItem] || cfgA.feedItem} por animal al día`,
      unknownMats: fp === null ? [cfgA.feedItem] : [],
    });
  }

  /* Liquidez */
  for (const s of streams) {
    const cap = Number(state.liquidity?.[s.name]);
    if (cap > 0 && s.unitsDay > cap) s.overLiquidity = cap;
  }

  streams.sort((a, b) => b.netFlowerDay - a.netFlowerDay);

  const profitable = streams.filter((s) => s.netFlowerDay > 0);
  const netFlowerDay = profitable.reduce((acc, s) => acc + s.netFlowerDay, 0);
  const coinsDay = profitable.reduce((acc, s) => acc + s.coinsDay, 0);

  const flowerUsd = Number(state.flowerUsdOverride) > 0 ? Number(state.flowerUsdOverride) : market?.flowerUsd ?? null;
  const usdPerFlower = flowerUsd ? flowerUsd * (1 - (state.cashoutFee || 0) / 100) : null;
  const usdMonth = usdPerFlower ? netFlowerDay * 30 * usdPerFlower : null;
  const neededFlowerDay = usdPerFlower ? state.targetUsd / 30 / usdPerFlower : null;

  return {
    streams,
    singleCrop,
    fruitRank,
    plan,
    plots,
    boosts,
    missingPrices: [...missingPrices],
    totals: { netFlowerDay, coinsDay, usdMonth, neededFlowerDay, flowerUsd, usdPerFlower },
  };
}

export function fmt(n, d = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return n.toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
