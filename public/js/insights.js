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
