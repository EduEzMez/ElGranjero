// Motor de rentabilidad de DonGranjero.
// Todo se expresa en FLOWER neto por día y después se convierte a USD.
import { CROPS, FRUITS, NODES, ANIMALS, BOOSTS, SEASON_CROPS, LABELS } from "./data.js";

const WARM_DAYS = 7; // días de "arranque" que se descartan para medir un régimen estable
const MEASURE_DAYS = 7;
const PLOT_DAYS = 30; // horizonte de la optimización de parcelas

/* ---------- Lectura de la granja ---------- */

const median = (arr) => {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function detectFarm(raw) {
  if (!raw) return null;
  const f = raw.farm ?? raw.data?.farm ?? raw.data ?? raw;
  // Nodos activos: los que tienen removedAt ya no están en la isla.
  const live = (o) => Object.values(o || {}).filter((n) => n && typeof n === "object" && !n.removedAt);

  // Coleccionables colocados: isla, interior y casa (se ignoran los retirados).
  const placed = new Set();
  const addPlaced = (obj) => {
    for (const [name, arr] of Object.entries(obj || {})) {
      if (Array.isArray(arr) && arr.some((x) => x && !x.removedAt)) placed.add(name);
    }
  };
  addPlaced(f.collectibles);
  addPlaced(f.home?.collectibles);
  for (const level of Object.values(f.interior || {})) addPlaced(level?.collectibles);

  // Wearables del bumpkin principal y de los farm hands.
  const wearables = new Set();
  const addWear = (eq) => Object.values(eq || {}).flat().forEach((v) => typeof v === "string" && wearables.add(v));
  addWear(f.bumpkin?.equipped);
  for (const hand of Object.values(f.farmHands?.bumpkins || {})) addWear(hand?.equipped);

  const skills = new Set(Object.keys(f.bumpkin?.skills || {}));

  // Boosts que el juego aplicó en los últimos 7 días (confirmación directa).
  const used = Object.entries(f.boostsUsedAt || {}).filter(([, t]) => Number.isFinite(t));
  const ref = Math.max(0, ...used.map(([, t]) => t));
  const recentBoosts = new Set(used.filter(([, t]) => t > ref - 7 * 864e5).map(([n]) => n));

  const has = (b) =>
    (b.type === "collectible" && placed.has(b.name)) ||
    (b.type === "wearable" && wearables.has(b.name)) ||
    (b.type === "skill" && skills.has(b.name)) ||
    recentBoosts.has(b.name);
  const specificTime = (name) =>
    BOOSTS.filter((b) => has(b) && b.timePct && (b.targets || []).includes(name)).reduce((m, b) => m * (1 + b.timePct / 100), 1);

  // Tiempos reales: cada nodo guarda boostedTime = milisegundos que te descuentan tus boosts.
  const base = {};
  for (const c of CROPS) base[c.name] = c.hours;
  for (const fr of FRUITS) base[fr.name] = fr.hours;
  for (const n of NODES) base[n.name] = n.hours;
  const samples = {};
  const sample = (name, ms, factor = 1) => {
    if (!base[name] || !Number.isFinite(ms) || ms <= 0) return;
    const ratio = Math.max(0.02, 1 - ms / (base[name] * 3600e3));
    (samples[name] ||= []).push(Math.min(1, ratio / factor));
  };
  let rapidRoot = false;
  for (const plot of live(f.crops)) {
    const c = plot.crop;
    if (!c?.name) continue;
    const rr = plot.fertiliser?.name === "Rapid Root";
    if (rr) rapidRoot = true;
    sample(c.name, c.boostedTime, rr ? 0.5 : 1); // se quita el Rapid Root (-50%) para tener el tiempo base con tus boosts
  }
  for (const p of live(f.fruitPatches)) if (p.fruit?.name) sample(p.fruit.name, p.fruit.boostedTime);
  for (const [key, name] of [["stones", "Stone"], ["iron", "Iron"], ["gold", "Gold"], ["crimstones", "Crimstone"]]) {
    for (const n of live(f[key])) sample(name, n.stone?.boostedTime);
  }
  const observedTime = {};
  for (const [k, v] of Object.entries(samples)) observedTime[k] = median(v);

  // Multiplicador general de cultivos y frutas, sin los boosts específicos del cultivo observado.
  const genericFrom = (list) =>
    median(list.filter((x) => observedTime[x.name]).map((x) => observedTime[x.name] / specificTime(x.name)));
  const genericCrop = genericFrom(CROPS);
  const genericFruit = genericFrom(FRUITS);

  // Árboles antiguos rinden más (multiplier).
  const trees = live(f.trees);
  const treeUnits = trees.reduce((a, t) => a + (Number(t.multiplier) || 1), 0);

  // Animales: ciclo real = de dormirse a despertarse.
  const animals = [...live(f.henHouse?.animals), ...live(f.barn?.animals)];
  const cycleOf = (type) =>
    median(animals.filter((a) => a.type === type && a.awakeAt && a.asleepAt).map((a) => (a.awakeAt - a.asleepAt) / 3600e3));

  // Comisión real del Marketplace según tus últimas ventas.
  const fees = Object.values(f.trades?.listings || {})
    .filter((l) => Number(l.sfl) > 0 && Number(l.tax) >= 0)
    .map((l) => (Number(l.tax) / Number(l.sfl)) * 100);

  return {
    counts: {
      crops: live(f.crops).length,
      fruits: live(f.fruitPatches).length,
      Wood: trees.length,
      Stone: live(f.stones).length,
      Iron: live(f.iron).length,
      Gold: live(f.gold).length,
      Crimstone: live(f.crimstones).length,
      Oil: live(f.oilReserves).length,
      Egg: animals.filter((a) => a.type === "Chicken").length,
      Milk: animals.filter((a) => a.type === "Cow").length,
      Wool: animals.filter((a) => a.type === "Sheep").length,
    },
    treeUnits,
    observedTime,
    genericCrop,
    genericFruit,
    rapidRoot,
    animalCycle: { Egg: cycleOf("Chicken"), Milk: cycleOf("Cow"), Wool: cycleOf("Sheep") },
    marketFee: median(fees),
    seedStock: f.stock || {},
    placed,
    wearables,
    skills,
    recentBoosts,
    season: f.season?.season ?? null,
    island: f.island?.type ?? null,
    coins: Number(f.coins) || 0,
    flower: Number(f.balance) || 0,
    username: f.username ?? null,
    vipUntil: f.vip?.expiresAt ?? null,
    timezone: f.settings?.timezone || "America/Argentina/Buenos_Aires",
    raw: f,
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
        (b.type === "skill" && detected.skills.has(b.name)) ||
        detected.recentBoosts?.has(b.name);
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

function modsFor(name, group, boosts, { skipTime = false, onlyExactTime = false } = {}) {
  let yieldPct = 0;
  let yieldAdd = 0;
  let timeMult = 1;
  const applied = [];
  for (const b of boosts) {
    const t = b.targets || [];
    if (!t.includes(name) && !t.includes(group) && !t.includes("all")) continue;
    yieldPct += b.yieldPct || 0;
    yieldAdd += b.yieldAdd || 0;
    if (b.timePct && !skipTime && (!onlyExactTime || t.includes(name))) timeMult *= 1 + b.timePct / 100;
    applied.push(b.name);
  }
  return { yieldPct, yieldAdd, timeMult: Math.max(0.05, timeMult), applied };
}

/* ---------- Cálculo principal ---------- */

export function compute({ state, detected, market, extraBoosts = [], sessionsOverride = null }) {
  const cfg = sessionsOverride ? { ...state, sessions: sessionsOverride } : state;
  const tl = timeline(cfg);
  const boosts = activeBoosts(detected, state, extraBoosts);
  const feePct = state.marketFeeAuto !== false && detected?.marketFee != null ? detected.marketFee : state.marketFee || 0;
  const fee = 1 - feePct / 100;
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
  // Rendimiento medido por el usuario (unidades por parcela/nodo/animal y cosecha). Manda sobre la tabla.
  const measuredYield = (name) => {
    const v = Number(state.measuredYields?.[name]?.perNode);
    return v > 0 ? v : null;
  };
  const useReal = state.useObservedTimes !== false && detected;
  const rapidRoot = state.rapidRoot ?? detected?.rapidRoot ?? false;
  // Devuelve { timeMult, source } usando, en orden: tiempo observado del recurso, multiplicador general observado, tabla de boosts.
  const timeFor = (name, group, boostsList) => {
    const obs = useReal ? detected.observedTime?.[name] : null;
    const generic = useReal ? (group === "crops" ? detected.genericCrop : group === "fruits" ? detected.genericFruit : null) : null;
    if (obs) return { timeMult: obs, source: "real" };
    if (generic) return { timeMult: generic * modsFor(name, group, boostsList, { onlyExactTime: true }).timeMult, source: "real-general" };
    return { timeMult: modsFor(name, group, boostsList).timeMult, source: "tabla" };
  };

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
    const yld = measuredYield(c.name) ?? (1 + m.yieldAdd) * (1 + m.yieldPct / 100);
    const tm = timeFor(c.name, "crops", boosts);
    cropOptions.push({
      name: c.name,
      timeSource: tm.source,
      yieldSource: measuredYield(c.name) != null ? "medido" : "tabla",
      cycleMin: c.hours * 60 * tm.timeMult * (rapidRoot ? 0.5 : 1),
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
        timeSource: o.timeSource,
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
        timeSource: o.timeSource,
        yieldSource: o.yieldSource,
        seedsDay: h * plots,
        harvestsDay: h * plots,
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
    const yld = measuredYield(fr.name) ?? (1 + m.yieldAdd) * (1 + m.yieldPct / 100);
    const tm = timeFor(fr.name, "fruits", boosts);
    const cycleMin = fr.hours * 60 * tm.timeMult;
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
      timeSource: tm.source,
      yieldSource: measuredYield(fr.name) != null ? "medido" : "tabla",
      harvestsDay: h * patches,
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
    let yld = ((nd.baseYield || 1) + m.yieldAdd) * (1 + m.yieldPct / 100);
    const measuredNode = measuredYield(nd.name);
    // Árboles antiguos: cada uno cuenta como varios árboles comunes.
    if (nd.name === "Wood" && detected?.treeUnits && state.countOverrides?.Wood == null) yld *= detected.treeUnits / k;
    if (measuredNode != null) yld = measuredNode; // lo medido ya incluye boosts y árboles antiguos
    const tm = timeFor(nd.name, "nodes", boosts);
    const cycleMin = nd.hours * 60 * tm.timeMult;
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
      timeSource: tm.source,
      yieldSource: measuredNode != null ? "medido" : "tabla",
      harvestsDay: h * k,
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
    const cycleH = (useReal && detected.animalCycle?.[an.name]) || 24;
    const perDayFactor = 24 / cycleH; // ciclos por día
    const measuredAnimal = measuredYield(an.name);
    const units = k * perDayFactor * (measuredAnimal ?? Number(cfgA.perDay) * (1 + m.yieldPct / 100) + m.yieldAdd);
    const fp = price(cfgA.feedItem);
    const feedCost = fp === null ? 0 : k * perDayFactor * Number(cfgA.feedQty) * fp;
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
      cycleMin: cycleH * 60,
      applied: m.applied,
      timeSource: useReal && detected.animalCycle?.[an.name] ? "real" : "tabla",
      harvestsDay: k * perDayFactor,
      detail: `alimento: ${cfgA.feedQty} ${LABELS[cfgA.feedItem] || cfgA.feedItem} por animal y ciclo`,
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
    feePct,
    fee,
    price,
    rapidRoot,
    totals: { netFlowerDay, coinsDay, usdMonth, neededFlowerDay, flowerUsd, usdPerFlower },
  };
}

export function fmt(n, d = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return n.toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d });
}
