// Análisis adicionales sobre los datos de la granja y el historial.
import { CROPS, FRUITS } from "./data.js";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function inventoryOf(farm) {
  const inv = {};
  for (const [k, v] of Object.entries(farm?.inventory || {})) inv[k] = num(v);
  return inv;
}

/* ---------- Entregas ---------- */

// Compara lo que paga cada entrega abierta con lo que valen sus ingredientes vendidos en el Marketplace.
export function analyzeDeliveries(farm, { price, fee, today }) {
  const inv = inventoryOf(farm);
  const doubleToday = (farm?.calendar?.dates || []).some((d) => d.name === "doubleDelivery" && d.date === today);
  const orders = (farm?.delivery?.orders || []).filter((o) => !o.completedAt);

  return orders
    .map((o) => {
      const needs = [];
      let ingredientValue = 0;
      let unpriced = 0;
      let coinsCost = 0;
      let haveAll = true;
      for (const [item, qtyRaw] of Object.entries(o.items || {})) {
        const qty = num(qtyRaw);
        if (item === "coins") {
          coinsCost += qty;
          continue;
        }
        if (item === "sfl") continue;
        const p = price(item);
        if (p === null) unpriced++;
        else ingredientValue += qty * p * fee;
        const have = inv[item] || 0;
        if (have < qty) haveAll = false;
        needs.push({ item, qty, have, price: p });
      }
      const mult = doubleToday ? 2 : 1;
      const rewardFlower = num(o.reward?.sfl) * mult;
      const rewardCoins = num(o.reward?.coins) * mult;
      const rewardItems = o.reward?.items && Object.keys(o.reward.items).length ? o.reward.items : null;
      const kind = rewardFlower > 0 ? "flower" : rewardCoins > 0 ? "coins" : rewardItems ? "items" : "tickets";
      // Si algún ingrediente no tiene precio, no se puede calcular el margen con honestidad.
      const margin = kind === "flower" && !unpriced ? rewardFlower - ingredientValue : null;
      return { id: o.id, from: o.from, needs, ingredientValue, unpriced, coinsCost, haveAll, rewardFlower, rewardCoins, rewardItems, kind, margin, doubleToday };
    })
    .sort((a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity));
}

/* ---------- Inventario ---------- */

const NOT_FOR_SALE = /Seed$|Plant$|Banner$|Ticket|Pickaxe$|^Axe$|Rod$|Shovel$|Drill$|Pot$|Rake$/;

// Valor de lo que tenés guardado, descontando lo que piden las entregas abiertas.
export function analyzeInventory(farm, { price, fee, liquidity, reserved, stats }) {
  const inv = inventoryOf(farm);
  const rows = [];
  for (const [item, qty] of Object.entries(inv)) {
    if (qty <= 0 || NOT_FOR_SALE.test(item)) continue;
    const p = price(item);
    if (p === null) continue;
    const keep = reserved[item] || 0;
    const sellable = Math.max(0, qty - keep);
    if (sellable <= 0) continue;
    const value = sellable * p * fee;
    const cap = num(liquidity?.[item]);
    const s = stats?.[item];
    const vsAvg = s && s.avg > 0 && s.samples >= 6 ? (p - s.avg) / s.avg : null;
    rows.push({ item, qty, keep, sellable, price: p, value, daysToSell: cap > 0 ? sellable / cap : null, vsAvg, stat: s || null });
  }
  rows.sort((a, b) => b.value - a.value);
  return { rows, total: rows.reduce((a, r) => a + r.value, 0) };
}

export function reservedByDeliveries(deliveries) {
  const out = {};
  for (const d of deliveries) {
    if (d.kind === "flower" && d.margin !== null && d.margin <= 0) continue; // las que no convienen no reservan
    for (const n of d.needs) out[n.item] = (out[n.item] || 0) + n.qty;
  }
  return out;
}

/* ---------- Calendario ---------- */

const EVENT_LABEL = {
  doubleDelivery: ["Entregas dobles", "Las entregas pagan el doble. Guardá stock para ese día."],
  fullMoon: ["Luna llena", "Evento de temporada."],
  bountifulHarvest: ["Cosecha abundante", "Rinde más la cosecha ese día."],
  tsunami: ["Tsunami", "Clima adverso: revisá tus protecciones."],
  greatFreeze: ["Gran helada", "Clima adverso: revisá tus protecciones."],
  insectPlague: ["Plaga", "Clima adverso: revisá tus protecciones."],
  tornado: ["Tornado", "Clima adverso: revisá tus protecciones."],
  sunshower: ["Lluvia de sol", "Los cultivos crecen más rápido."],
  unknown: ["Clima a confirmar", "El juego anuncia el evento ese mismo día."],
};

export function upcomingEvents(farm, today, limit = 8) {
  return (farm?.calendar?.dates || [])
    .filter((d) => d.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit)
    .map((d) => {
      const [title, note] = EVENT_LABEL[d.name] || [d.name, ""];
      return { date: d.date, name: d.name, title, note, today: d.date === today };
    });
}

/* ---------- Bounties ---------- */

export function coinBounties(farm) {
  const done = new Set((farm?.bounties?.completed || []).map((c) => c.id));
  const animals = [...Object.values(farm?.henHouse?.animals || {}), ...Object.values(farm?.barn?.animals || {})];
  return (farm?.bounties?.requests || [])
    .filter((b) => !done.has(b.id) && num(b.coins) > 0)
    .map((b) => ({
      name: b.name,
      level: b.level ?? null,
      coins: num(b.coins),
      owned: animals.filter((a) => a.type === b.name).length,
    }))
    .sort((a, b) => b.coins - a.coins);
}

/* ---------- Historial ---------- */

const sumKeys = (act, keys) => keys.reduce((a, k) => a + num(act?.[k]), 0);

// Contadores de cosecha por grupo, para comparar el ritmo real con el plan.
const HARVEST_COUNTERS = {
  crops: CROPS.map((c) => `${c.name} Harvested`),
  fruits: FRUITS.map((f) => `${f.name} Harvested`),
  Wood: ["Basic Tree Chopped", "Ancient Tree Chopped"],
  Stone: ["Stone Rock Mined"],
  Iron: ["Iron Rock Mined"],
  Gold: ["Gold Rock Mined"],
  Crimstone: ["Crimstone Mined"],
  Oil: ["Oil Drilled"],
  Egg: ["Egg Collected"],
  Milk: ["Milk Collected"],
  Wool: ["Wool Collected"],
};

export function historyMetrics(history, { windowDays = 7 } = {}) {
  const days = history?.days || [];
  if (days.length < 2) return null;
  const last = days[days.length - 1];
  const firstIdx = Math.max(0, days.length - 1 - windowDays);
  const first = days[firstIdx];
  const span = Math.max(0.5, (Date.parse(last.takenAt) - Date.parse(first.takenAt)) / 86400e3);

  const delta = (k) => num(last.activity?.[k]) - num(first.activity?.[k]);
  const earned = delta("SFL Earned");
  const spent = delta("SFL Spent") + delta("FLOWER Spent");
  const coinsIn = delta("Coins Earned");
  const coinsOut = delta("Coins Spent");

  // Ingreso diario (barras): diferencia día a día de "SFL Earned".
  const daily = [];
  for (let i = Math.max(1, days.length - 14); i < days.length; i++) {
    const a = days[i - 1];
    const b = days[i];
    daily.push({ day: b.day, earned: num(b.activity?.["SFL Earned"]) - num(a.activity?.["SFL Earned"]) });
  }

  // null = el juego no registra ese contador en tu granja (no se puede medir).
  const harvests = {};
  for (const [group, keys] of Object.entries(HARVEST_COUNTERS)) {
    const tracked = keys.some((k) => last.activity && k in last.activity);
    harvests[group] = tracked ? (sumKeys(last.activity, keys) - sumKeys(first.activity, keys)) / span : null;
  }

  // Otras actividades que se movieron (pesca, miel, sal, excavación, etc.).
  const known = new Set(Object.values(HARVEST_COUNTERS).flat().concat(["SFL Earned", "SFL Spent", "FLOWER Spent", "Coins Earned", "Coins Spent"]));
  const other = Object.keys(last.activity || {})
    .filter((k) => !known.has(k) && !/ (Fed|Bountied)$/.test(k))
    .map((k) => ({ key: k, perDay: delta(k) / span }))
    .filter((x) => x.perDay > 0.05)
    .sort((a, b) => b.perDay - a.perDay)
    .slice(0, 15);

  return {
    span,
    firstDay: first.day,
    lastDay: last.day,
    earnedPerDay: earned / span,
    spentPerDay: spent / span,
    coinsInPerDay: coinsIn / span,
    coinsOutPerDay: coinsOut / span,
    flowerBalanceDelta: num(last.flower) - num(first.flower),
    daily,
    harvests,
    other,
  };
}

/* ---------- Calendario mensual ---------- */

const pad = (n) => String(n).padStart(2, "0");
const isoDay = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// Reparte la meta del mes día por día.
// - Días pasados: lo ganado (contador "SFL Earned") contra una vara fija = meta ÷ días con datos.
// - Hoy y días futuros: lo que falta se reparte según el peso de cada día (libre 0, normal 1, fuerte 1,5).
// - Los días anteriores al primer registro no cuentan: la meta se prorratea desde ahí.
export function monthCalendar({ history, today, goalUsd, usdPerFlowerNow, cashout, weights = {}, events = [], capacityUsdDay = null }) {
  const [y, m] = today.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const todayN = Number(today.slice(8, 10));
  const snaps = history?.days || [];
  const priceOf = (d) => {
    const p = history?.flowerDaily?.[d];
    return p ? p * (1 - cashout) : usdPerFlowerNow;
  };

  // Ganado por día a partir de fotos consecutivas.
  const earned = {};
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1];
    const b = snaps[i];
    const delta = num(b.activity?.["SFL Earned"]) - num(a.activity?.["SFL Earned"]);
    const gap = Math.round((Date.parse(b.day) - Date.parse(a.day)) / 86400e3);
    earned[b.day] = { flower: Math.max(0, delta), merged: gap > 1 };
  }

  const doubleDays = new Set(events.filter((e) => e.name === "doubleDelivery").map((e) => e.date));
  const weightOf = (d) => (d in weights ? weights[d] : doubleDays.has(d) ? 1.5 : 1);

  // Primer día del mes con datos (si no hay, hoy).
  let startN = todayN;
  for (let n = 1; n <= todayN; n++) {
    if (earned[isoDay(y, m, n)]) {
      startN = n;
      break;
    }
  }
  const trackedDays = daysInMonth - startN + 1;
  const goal = goalUsd * (trackedDays / daysInMonth);
  const baseline = goal / trackedDays;

  let earnedPast = 0;
  const days = [];
  for (let n = 1; n <= daysInMonth; n++) {
    const d = isoDay(y, m, n);
    const e = earned[d];
    const usd = e && usdPerFlowerNow ? e.flower * priceOf(d) : null;
    const day = { date: d, n, weekday: new Date(y, m - 1, n).getDay(), weight: weightOf(d), events: events.filter((ev) => ev.date === d), merged: !!e?.merged };
    if (n < startN) day.status = "nodata";
    else if (n < todayN) {
      day.earnedFlower = e ? e.flower : 0;
      day.earnedUsd = usd ?? 0;
      earnedPast += day.earnedUsd;
      const r = baseline > 0 ? day.earnedUsd / baseline : 0;
      day.status = !e ? "nodata" : r >= 0.98 ? "done" : r >= 0.5 ? "partial" : "missed";
      day.ratio = r;
    } else if (n === todayN) {
      day.status = "today";
      day.earnedFlower = e ? e.flower : 0;
      day.earnedUsd = usd ?? 0;
    } else day.status = "future";
    days.push(day);
  }

  // Reparto de lo que falta entre hoy y los días que vienen.
  const remaining = Math.max(0, goal - earnedPast);
  const ahead = days.filter((d) => d.status === "today" || d.status === "future");
  const wSum = ahead.reduce((a, d) => a + d.weight, 0);
  for (const d of ahead) {
    d.targetUsd = wSum > 0 ? (remaining * d.weight) / wSum : 0;
    d.targetFlower = usdPerFlowerNow ? d.targetUsd / usdPerFlowerNow : null;
    if (capacityUsdDay) d.demanding = d.weight > 0 && d.targetUsd > capacityUsdDay * Math.max(1, d.weight) * 1.05;
  }
  const t = days[todayN - 1];
  if (t.targetUsd > 0) {
    t.ratio = t.earnedUsd / t.targetUsd;
    if (t.ratio >= 0.98) t.status = "today-done";
  }

  // Pronóstico de fin de mes: lo ya ganado + tu ritmo diario en los días que vas a jugar.
  const futureActive = days.filter((d) => d.status === "future" && d.weight > 0).length;
  const todayPart = t.weight > 0 ? Math.max(t.earnedUsd || 0, capacityUsdDay || 0) : t.earnedUsd || 0;
  const forecast = capacityUsdDay != null ? earnedPast + todayPart + capacityUsdDay * futureActive : null;

  return {
    year: y,
    month: m,
    daysInMonth,
    startN,
    prorated: startN > 1,
    goal,
    baseline,
    earnedPast,
    earnedToday: t.earnedUsd || 0,
    remaining,
    forecast,
    days,
    doneCount: days.filter((d) => d.status === "done").length,
    missedCount: days.filter((d) => d.status === "missed" || d.status === "partial").length,
  };
}

// Sugiere qué vender del inventario para cubrir una cantidad de FLOWER.
export function coverWithInventory(inventoryRows, flowerNeeded, max = 3) {
  const out = [];
  let left = flowerNeeded;
  for (const r of inventoryRows) {
    if (left <= 0 || out.length >= max) break;
    const perUnit = r.value / r.sellable;
    if (!(perUnit > 0)) continue;
    const units = Math.min(r.sellable, Math.ceil(left / perUnit));
    out.push({ item: r.item, units, flower: units * perUnit, have: r.sellable });
    left -= units * perUnit;
  }
  return { picks: out, covered: flowerNeeded - Math.max(0, left), short: Math.max(0, left) };
}
