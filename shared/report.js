// Arma el mismo análisis que ve la web, pero del lado del servidor, para el bot de Telegram.
import { compute, detectFarm, fmt } from "../public/js/engine.js";
import { DEFAULTS, LABELS } from "../public/js/data.js";
import {
  analyzeDeliveries, analyzeInventory, reservedByDeliveries, historyMetrics, monthCalendar, upcomingEvents, coverWithInventory,
} from "../public/js/insights.js";
import { readLatestFarm, dayIn } from "./sfl.js";

const label = (n) => LABELS[n] || n;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const safe = (s) => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
};

export async function loadContext(db, env) {
  const id = Number(env.FARM_ID || 441);
  const tz = env.TIMEZONE || "America/Argentina/Buenos_Aires";
  const now = Date.now();

  const [farmRow, settingsRow, snaps, prices] = await Promise.all([
    readLatestFarm(db, id),
    db.prepare("SELECT data FROM settings WHERE farm_id = ?").bind(id).first(),
    db.prepare("SELECT day, taken_at, coins, flower, activity FROM snapshots WHERE farm_id = ? ORDER BY day DESC LIMIT 40").bind(id).all(),
    db.prepare("SELECT taken_at, flower_usd, prices FROM prices WHERE taken_at >= ? ORDER BY taken_at").bind(new Date(now - 40 * 86400e3).toISOString()).all(),
  ]);

  const state = { ...structuredClone(DEFAULTS), ...(settingsRow ? safe(settingsRow.data) : {}) };
  const detected = farmRow ? detectFarm(farmRow.data) : null;

  // Precios: último registro + estadísticas de 7 días + precio diario de FLOWER.
  const rows = (prices.results || []).map((r) => ({ t: Date.parse(r.taken_at), usd: r.flower_usd, p: safe(r.prices) }));
  const latest = rows.at(-1);
  const priceStats = {};
  for (const r of rows.filter((x) => x.t >= now - 7 * 86400e3)) {
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
  const flowerDaily = {};
  const perDay = {};
  for (const r of rows) if (r.usd) (perDay[dayIn(tz, new Date(r.t))] ||= []).push(r.usd);
  for (const [d, v] of Object.entries(perDay)) flowerDaily[d] = v.reduce((a, b) => a + b, 0) / v.length;

  const market = latest ? { prices: latest.p, flowerUsd: latest.usd } : { prices: {}, flowerUsd: null };
  const history = {
    days: (snaps.results || []).map((r) => ({ day: r.day, takenAt: r.taken_at, coins: r.coins, flower: r.flower, activity: safe(r.activity) })).reverse(),
    priceStats,
    flowerDaily,
  };

  const result = compute({ state, detected, market });
  const today = dayIn(tz);
  const farm = detected?.raw;
  const deliveries = farm ? analyzeDeliveries(farm, { price: result.price, fee: result.fee, today }) : [];
  const inventory = farm
    ? analyzeInventory(farm, { price: result.price, fee: result.fee, liquidity: state.liquidity, reserved: reservedByDeliveries(deliveries), stats: priceStats })
    : { rows: [], total: 0 };
  const metrics = historyMetrics(history);
  const t = result.totals;
  const capacityUsdDay = t.usdPerFlower ? (metrics ? metrics.earnedPerDay * t.usdPerFlower : t.usdMonth != null ? t.usdMonth / 30 : null) : null;
  const monthEvents = farm ? upcomingEvents(farm, today.slice(0, 8) + "01", 60) : [];
  const calendar = t.usdPerFlower
    ? monthCalendar({
        history, today, goalUsd: state.targetUsd, usdPerFlowerNow: t.usdPerFlower, cashout: (state.cashoutFee || 0) / 100,
        weights: state.dayWeights || {}, events: monthEvents, capacityUsdDay,
      })
    : null;

  return { id, tz, now, state, detected, farm, farmFetchedAt: farmRow?.fetchedAt, market, history, rows, result, today, deliveries, inventory, metrics, calendar, monthEvents };
}

const hm = (ms, tz) => new Intl.DateTimeFormat("es-AR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
const ago = (iso) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(min)) return "–";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
};

/* ---------- Comandos ---------- */

export function textHoy(ctx) {
  const c = ctx.calendar;
  if (!c) return "Todavía no tengo el precio de FLOWER para calcular tu meta de hoy.";
  const d = c.days.find((x) => x.date === ctx.today);
  if (!d) return "No encontré el día de hoy en el calendario.";
  if (d.weight === 0) return "📅 Hoy está marcado como <b>día libre</b>: su parte de la meta se reparte en los demás días.";
  const missing = Math.max(0, (d.targetFlower || 0) - (d.earnedFlower || 0));
  const lines = [
    `📅 <b>Hoy</b>`,
    `Meta: <b>${fmt(d.targetFlower, 2)} FLOWER</b> (≈ US$ ${fmt(d.targetUsd, 2)})`,
    `Llevás: ${fmt(d.earnedFlower || 0, 2)} FLOWER (${fmt((d.ratio || 0) * 100, 0)}%)`,
  ];
  if (missing <= 0.01) lines.push("🌻 ¡Meta del día cumplida!");
  else {
    lines.push(`Faltan: <b>${fmt(missing, 2)} FLOWER</b>`);
    const deliv = ctx.deliveries.filter((x) => x.kind === "flower" && x.margin > 0 && x.haveAll).slice(0, 2);
    const cover = coverWithInventory(ctx.inventory.rows, missing);
    const todo = [
      ...deliv.map((x) => `• Entrega de ${esc(x.from)}: ${fmt(x.rewardFlower, 2)} FLOWER`),
      ...cover.picks.map((p) => `• Vendé ${fmt(p.units, 0)} ${esc(label(p.item))} ≈ ${fmt(p.flower, 2)} FLOWER`),
    ];
    if (todo.length) lines.push("", "Podés:", ...todo);
  }
  const ev = d.events.map((e) => `• ${esc(e.title)}`);
  if (ev.length) lines.push("", "Eventos:", ...ev);
  lines.push("", `Mes: US$ ${fmt(c.earnedPast + c.earnedToday, 2)} de ${fmt(c.goal, 2)}`);
  return lines.join("\n");
}

export function textVender(ctx) {
  const rows = ctx.inventory.rows.slice(0, 6);
  if (!rows.length) return "No encontré inventario con precio de mercado.";
  const usd = ctx.result.totals.usdPerFlower;
  const lines = [`🧺 <b>Qué conviene vender</b>`, `Inventario vendible: ${fmt(ctx.inventory.total, 2)} FLOWER${usd ? ` (≈ US$ ${fmt(ctx.inventory.total * usd, 2)})` : ""}`, ""];
  for (const r of rows) {
    const sig = r.vsAvg == null ? "" : r.vsAvg >= 0.05 ? ` 📈 +${fmt(r.vsAvg * 100, 0)}%` : r.vsAvg <= -0.05 ? ` 📉 ${fmt(r.vsAvg * 100, 0)}% (esperá)` : "";
    lines.push(`• ${esc(label(r.item))}: ${fmt(r.sellable, 0)} ≈ ${fmt(r.value, 2)} FLOWER${sig}`);
  }
  const good = ctx.deliveries.filter((x) => x.kind === "flower" && x.margin > 0).slice(0, 3);
  if (good.length) lines.push("", "Entregas que convienen:", ...good.map((x) => `• ${esc(x.from)}: ${fmt(x.rewardFlower, 2)} FLOWER (+${fmt(x.margin, 2)})`));
  return lines.join("\n");
}

export function textIsla(ctx) {
  const ws = (ctx.farm?.floatingIsland?.schedule || []).filter((w) => Number(w.endAt) > ctx.now).slice(0, 3);
  if (!ws.length) return "🏝️ No tengo próximas aperturas de la isla flotante. Se actualizan cuando el Worker lee la granja.";
  return ["🏝️ <b>Isla flotante</b>", ...ws.map((w) => (Number(w.startAt) <= ctx.now ? `• Abierta ahora, hasta las ${hm(w.endAt, ctx.tz)}` : `• ${dayIn(ctx.tz, new Date(w.startAt)) === ctx.today ? "Hoy" : "Mañana"} de ${hm(w.startAt, ctx.tz)} a ${hm(w.endAt, ctx.tz)}`))].join("\n");
}

export function textEstado(ctx) {
  const t = ctx.result.totals;
  const lines = [`🌻 <b>Estado de la granja #${ctx.id}</b>`];
  lines.push(`Datos de la granja: ${ctx.farmFetchedAt ? ago(ctx.farmFetchedAt) : "sin datos"}`);
  lines.push(`FLOWER: ${t.flowerUsd ? `US$ ${fmt(t.flowerUsd, 4)}` : "sin precio"}`);
  if (t.usdMonth != null) lines.push(`Proyección: US$ ${fmt(t.usdMonth, 2)}/mes (meta US$ ${fmt(ctx.state.targetUsd, 0)})`);
  if (ctx.metrics && t.usdPerFlower) lines.push(`Real (${fmt(ctx.metrics.span, 0)} días): ${fmt(ctx.metrics.earnedPerDay, 2)} FLOWER/día ≈ US$ ${fmt(ctx.metrics.earnedPerDay * 30 * t.usdPerFlower, 2)}/mes`);
  const top = ctx.result.streams.find((s) => s.netFlowerDay > 0);
  if (top) lines.push(`Mejor recurso: ${esc(label(top.name))} (${fmt(top.netFlowerDay, 2)} FLOWER/día)`);
  if (ctx.detected) lines.push(`Coins: ${fmt(ctx.detected.coins, 0)} · FLOWER en la granja: ${fmt(ctx.detected.flower, 2)}`);
  return lines.join("\n");
}

export function textSemana(ctx) {
  const t = ctx.result.totals;
  const days = ctx.history.days;
  const last = days.at(-1);
  const weekAgo = [...days].reverse().find((d) => Date.parse(last?.takenAt) - Date.parse(d.takenAt) >= 6.5 * 86400e3) || days[0];
  const lines = ["📊 <b>Resumen de la semana</b>"];
  if (last && weekAgo && last !== weekAgo) {
    const earned = Number(last.activity?.["SFL Earned"] || 0) - Number(weekAgo.activity?.["SFL Earned"] || 0);
    const span = (Date.parse(last.takenAt) - Date.parse(weekAgo.takenAt)) / 86400e3;
    lines.push(`Ganaste <b>${fmt(earned, 2)} FLOWER</b> en ${fmt(span, 0)} días${t.usdPerFlower ? ` (≈ US$ ${fmt(earned * t.usdPerFlower, 2)})` : ""}`);
    const weekGoal = ((ctx.state.targetUsd || 0) / 30) * span;
    if (t.usdPerFlower) lines.push(earned * t.usdPerFlower >= weekGoal ? `✅ Por encima de lo necesario (US$ ${fmt(weekGoal, 2)})` : `⚠️ Debajo de lo necesario (US$ ${fmt(weekGoal, 2)})`);
  } else lines.push("Todavía no hay una semana de historial.");
  const c = ctx.calendar;
  if (c) lines.push(`Mes: US$ ${fmt(c.earnedPast + c.earnedToday, 2)} de ${fmt(c.goal, 2)}${c.forecast != null ? ` · cierre estimado US$ ${fmt(c.forecast, 2)}` : ""}`);
  const fd = Object.entries(ctx.history.flowerDaily).sort(([a], [b]) => a.localeCompare(b)).slice(-8);
  if (fd.length > 1) {
    const ch = (fd.at(-1)[1] / fd[0][1] - 1) * 100;
    lines.push(`FLOWER: US$ ${fmt(fd.at(-1)[1], 4)} (${ch >= 0 ? "+" : ""}${fmt(ch, 1)}% en la semana)`);
  }
  const top = ctx.result.streams.find((s) => s.netFlowerDay > 0);
  if (top) lines.push(`Mejor recurso: ${esc(label(top.name))}`);
  const nextDouble = ctx.monthEvents.filter((e) => e.name === "doubleDelivery" && e.date > ctx.today).slice(0, 2);
  if (nextDouble.length) lines.push(`Próximas entregas dobles: ${nextDouble.map((e) => e.date.slice(8, 10) + "/" + e.date.slice(5, 7)).join(", ")}`);
  return lines.join("\n");
}

export const HELP = [
  "🌻 <b>DonGranjero</b>",
  "/hoy · meta del día y qué hacer",
  "/vender · qué conviene vender",
  "/isla · próximas aperturas de la isla flotante",
  "/estado · resumen de la granja",
  "/semana · resumen de los últimos 7 días",
].join("\n");

/* ---------- Alertas de precio ---------- */

// Devuelve los mensajes nuevos y el registro actualizado de alertas enviadas (para no repetir).
export function priceAlerts(ctx, sent = {}) {
  const st = ctx.state;
  if (st.priceAlerts === false) return { messages: [], sent };
  const now = ctx.now;
  const pct = Number(st.priceAlertPct) || 15;
  const flowerPct = Number(st.flowerAlertPct) || 10;
  const minValue = Number(st.alertMinFlower) || 2;
  const out = [];
  const next = { ...sent };
  for (const k of Object.keys(next)) if (now - next[k] > 3 * 86400e3) delete next[k];

  // Recursos del inventario por encima de su promedio de 7 días.
  for (const r of ctx.inventory.rows) {
    const s = r.stat;
    if (!s || s.samples < 24 || r.value < minValue || !(s.avg > 0)) continue;
    const up = (r.price - s.avg) / s.avg;
    const key = `item:${r.item}`;
    if (up * 100 >= pct && !(now - (next[key] || 0) < 86400e3)) {
      out.push(`📈 <b>${esc(label(r.item))}</b> está ${fmt(up * 100, 0)}% arriba de su promedio de 7 días (${fmt(r.price, 4)} vs ${fmt(s.avg, 4)}). Tenés ${fmt(r.sellable, 0)} ≈ ${fmt(r.value, 2)} FLOWER.`);
      next[key] = now;
    }
  }

  // FLOWER: variación contra hace ~24 h.
  const rows = ctx.rows.filter((x) => x.usd);
  const cur = rows.at(-1);
  const dayAgo = [...rows].reverse().find((x) => cur && cur.t - x.t >= 23 * 3600e3);
  if (cur && dayAgo) {
    const ch = (cur.usd / dayAgo.usd - 1) * 100;
    const key = `flower:${ch >= 0 ? "up" : "down"}`;
    if (Math.abs(ch) >= flowerPct && !(now - (next[key] || 0) < 12 * 3600e3)) {
      out.push(`${ch >= 0 ? "🚀" : "🔻"} <b>FLOWER</b> ${ch >= 0 ? "subió" : "bajó"} ${fmt(Math.abs(ch), 1)}% en 24 h: US$ ${fmt(cur.usd, 4)}.`);
      next[key] = now;
    }
  }
  return { messages: out, sent: next };
}
