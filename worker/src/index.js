// Worker programado de DonGranjero.
// Cada 5 minutos:
//   1. Si pasó FARM_INTERVAL_MIN desde la última consulta, trae la granja, guarda la foto del día,
//      las ventas cobradas y recalcula cuándo está lista cada cosa.
//   2. Si pasó MARKET_INTERVAL_MIN, guarda los precios del mercado.
//   3. Manda por Telegram lo que ya está listo y todavía no se avisó.
import {
  fetchFarmUpstream, farmOf, writeLatestFarm, fetchMarket, saveSnapshot, saveSales, computeTimers, saveTimers,
} from "../../shared/sfl.js";

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  // GET /           estado
  // GET /run?key=   fuerza una corrida (RUN_KEY)
  // GET /test?key=  manda un mensaje de prueba a Telegram
  async fetch(request, env) {
    const url = new URL(request.url);
    const authorized = env.RUN_KEY && url.searchParams.get("key") === env.RUN_KEY;
    if (url.pathname === "/run" && authorized) return Response.json(await run(env, { force: true }));
    if (url.pathname === "/test" && authorized) {
      const ok = await sendTelegram(env, "🌻 DonGranjero: los avisos están funcionando.");
      return Response.json({ ok });
    }
    const meta = await readMeta(env.DB);
    return Response.json({ service: "dongranjero-cron", farmId: env.FARM_ID, ...meta });
  },
};

async function run(env, { force = false } = {}) {
  const db = env.DB;
  const id = Number(env.FARM_ID || 441);
  const now = Date.now();
  const meta = await readMeta(db);
  const log = { at: new Date().toISOString() };

  // 1. Granja
  const farmEvery = (Number(env.FARM_INTERVAL_MIN) || 30) * 60e3;
  if (force || !meta.lastFarmAt || now - Date.parse(meta.lastFarmAt) >= farmEvery) {
    try {
      const data = await fetchFarmUpstream(env, id);
      const farm = farmOf(data);
      await writeLatestFarm(db, id, data);
      await saveSnapshot(db, id, farm, env.TIMEZONE);
      log.sales = await saveSales(db, id, farm);
      const timers = computeTimers(farm);
      await saveTimers(db, id, timers);
      log.timers = timers.length;
      await writeMeta(db, { lastFarmAt: new Date().toISOString(), lastFarmError: "" });
    } catch (err) {
      log.farmError = err.message;
      // Con 429 no se insiste: se reintenta en la próxima ventana.
      await writeMeta(db, { lastFarmAt: new Date().toISOString(), lastFarmError: err.message });
    }
  }

  // 2. Precios
  const marketEvery = (Number(env.MARKET_INTERVAL_MIN) || 60) * 60e3;
  if (force || !meta.lastMarketAt || now - Date.parse(meta.lastMarketAt) >= marketEvery) {
    try {
      const m = await fetchMarket(env);
      if (Object.keys(m.prices).length || m.flowerUsd) {
        await db.prepare("INSERT OR REPLACE INTO prices (taken_at, flower_usd, prices) VALUES (?, ?, ?)").bind(m.fetchedAt, m.flowerUsd, JSON.stringify(m.prices)).run();
        await db.prepare("DELETE FROM prices WHERE taken_at < ?").bind(new Date(now - 45 * 86400e3).toISOString()).run();
      }
      await writeMeta(db, { lastMarketAt: m.fetchedAt });
    } catch (err) {
      log.marketError = err.message;
    }
  }

  // 3. Avisos
  log.notified = await notifyReady(env, id);
  await writeMeta(db, { lastRunAt: log.at });
  return log;
}

async function notifyReady(env, id) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return 0;
  if (inQuietHours(env)) return 0;
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT key, label, ready_at FROM timers WHERE farm_id = ? AND notified = 0 AND ready_at <= ? AND ready_at > ? ORDER BY ready_at"
  )
    .bind(id, now, now - 12 * 3600e3)
    .all();
  if (!results?.length) return 0;

  const lines = results.map((r) => `• ${escapeHtml(r.label)}`);
  const link = env.SITE_URL ? `\n\n<a href="${env.SITE_URL}">Abrir DonGranjero</a>` : "";
  const ok = await sendTelegram(env, `🌻 <b>Listo para cosechar</b>\n${lines.join("\n")}${link}`);
  if (ok) {
    await env.DB.batch(results.map((r) => env.DB.prepare("UPDATE timers SET notified = 1 WHERE farm_id = ? AND key = ?").bind(id, r.key)));
  }
  return ok ? results.length : 0;
}

function inQuietHours(env) {
  if (env.QUIET_FROM === "" || env.QUIET_TO === "" || env.QUIET_FROM == null || env.QUIET_TO == null) return false;
  const from = Number(env.QUIET_FROM);
  const to = Number(env.QUIET_TO);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: env.TIMEZONE || "UTC", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return res.ok;
}

async function readMeta(db) {
  const { results } = await db.prepare("SELECT key, value FROM meta").all();
  return Object.fromEntries((results || []).map((r) => [r.key, r.value]));
}

async function writeMeta(db, obj) {
  await db.batch(
    Object.entries(obj).map(([k, v]) =>
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(v ?? ""))
    )
  );
}

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
