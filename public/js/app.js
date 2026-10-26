import { CROPS, FRUITS, NODES, ANIMALS, BOOSTS, DEFAULTS, LABELS, CATEGORY_LABEL, SEASON_CROPS, SEASON_LABEL } from "./data.js";
import { compute, detectFarm, fmt } from "./engine.js";
import { icon } from "./icons.js";
import { analyzeDeliveries, analyzeInventory, reservedByDeliveries, upcomingEvents, coinBounties, historyMetrics, monthCalendar, coverWithInventory } from "./insights.js";

const LS_STATE = "dongranjero:state:v1";
const LS_FARM = "dongranjero:farm:v1";
const LS_MARKET = "dongranjero:market:v1";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const label = (n) => LABELS[n] || n;
const CAT_OF = Object.fromEntries([
  ...CROPS.map((c) => [c.name, "crop"]),
  ...FRUITS.map((f) => [f.name, "fruit"]),
  ...NODES.map((n) => [n.name, "node"]),
  ...ANIMALS.map((x) => [x.name, "animal"]),
]);
const ic = (name, size = 24, category = CAT_OF[name]) => icon(name, { size, category });
const withIcon = (name, size = 20) => `<span class="res">${ic(name, size)}${esc(label(name))}</span>`;

function paintStaticIcons() {
  $$("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.size) || 24 });
    el.style.display = "inline-flex";
  });
}
const clone = (o) => JSON.parse(JSON.stringify(o));

let state = loadState();
let farmPayload = readLS(LS_FARM); // { fetchedAt, data }
let market = readLS(LS_MARKET); // { prices, flowerUsd, ... }
let detected = farmPayload ? detectFarm(farmPayload.data) : null;
let result = null;
let history = null; // respuesta de /api/history
let historyError = "";
let selectedDay = null; // fecha elegida en el calendario
let farmStaleAt = null; // fecha de la foto guardada cuando el Worker no pudo renovarla
let insights = { deliveries: [], inventory: { rows: [], total: 0 }, events: [], bounties: [], metrics: null };
let rankFilter = "all";
const status = { farm: "", market: "" };

/* ---------- Persistencia ---------- */

function loadState() {
  const saved = readLS(LS_STATE) || {};
  return { ...clone(DEFAULTS), ...saved };
}
function saveState() {
  writeLS(LS_STATE, state);
}
function readLS(k) {
  try {
    return JSON.parse(localStorage.getItem(k));
  } catch {
    return null;
  }
}
function writeLS(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* almacenamiento lleno o bloqueado: seguimos en memoria */
  }
}

/* ---------- Datos remotos ---------- */

function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(min)) return "";
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}

const FARM_MIN_AGE_MS = 5 * 60 * 1000;

async function loadFarm(id, { force = false } = {}) {
  // Si los datos guardados tienen menos de 5 minutos, no se vuelve a consultar.
  const sameFarm = farmPayload?.farmId === Number(id);
  const age = farmPayload?.fetchedAt ? Date.now() - new Date(farmPayload.fetchedAt).getTime() : Infinity;
  if (!force && sameFarm && age < FARM_MIN_AGE_MS) return;

  status.farm = `Cargando granja #${id}…`;
  renderStatus();
  try {
    const res = await fetch(`/api/farm/${encodeURIComponent(id)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error([body.error, body.hint].filter(Boolean).join(". ") || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    farmPayload = { farmId: Number(id), fetchedAt: body.fetchedAt, data: body.data };
    writeLS(LS_FARM, farmPayload);
    detected = detectFarm(body.data);
    farmStaleAt = body.stale ? body.fetchedAt : null;
    status.farm = "";
  } catch (err) {
    if (sameFarm && farmPayload?.data) {
      status.farm =
        err.status === 429
          ? `La API de Sunflower Land está limitando consultas: se muestran tus datos guardados de ${ago(farmPayload.fetchedAt)}. Probá de nuevo en unos minutos.`
          : `No se pudo actualizar la granja (${err.message.replace(/\.+$/, "")}). Se muestran tus datos guardados de ${ago(farmPayload.fetchedAt)}.`;
    } else {
      status.farm = `No se pudo cargar la granja: ${err.message.replace(/\.+$/, "")}. Podés cargar las cantidades a mano en la pestaña Granja.`;
    }
  }
}

async function loadMarket() {
  status.market = "Actualizando precios…";
  renderStatus();
  try {
    const res = await fetch("/api/market");
    const body = await res.json();
    if (!res.ok) throw new Error(`Error ${res.status}`);
    market = body;
    writeLS(LS_MARKET, market);
    const errs = body.errors || [];
    status.market = errs.length ? `Precios incompletos: ${errs.map((e) => e.message).join(" · ")}` : "";
  } catch (err) {
    status.market = `No se pudieron actualizar los precios (${err.message}). Se usan los últimos guardados o los manuales.`;
  }
}

async function loadHistory() {
  try {
    const tz = detected?.timezone || "America/Argentina/Buenos_Aires";
    const res = await fetch(`/api/history?farm=${encodeURIComponent(state.farmId)}&tz=${encodeURIComponent(tz)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
    history = body;
    historyError = "";
  } catch (err) {
    history = null;
    historyError = err.message;
  }
}

function todayIn(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function refreshAll(force = false) {
  const btn = $("#refreshBtn");
  btn.classList.add("spin");
  btn.disabled = true;
  await Promise.all([loadFarm(state.farmId, { force }), loadMarket(), loadHistory()]);
  btn.classList.remove("spin");
  btn.disabled = false;
  recompute(true);
}

/* ---------- Cálculo y render ---------- */

// Precio de FLOWER según la fuente elegida: promedio de pools (auto), un pool puntual o manual.
function marketView() {
  if (!market) return market;
  const src = state.flowerSource || "auto";
  if (src !== "auto") {
    const pool = (market.pools || []).find((p) => p.id === src);
    if (pool) return { ...market, flowerUsd: pool.priceUsd, flowerSourceLabel: `${pool.dex} ${pool.pair}` };
  }
  const n = market.flowerPair?.pools || 0;
  return { ...market, flowerSourceLabel: n > 1 ? `promedio de ${n} pools` : market.flowerPair?.dex || "" };
}

function recompute(animate = false) {
  result = compute({ state, detected, market: marketView() });
  buildInsights();
  renderHeader();
  renderStatus();
  renderGoal(animate);
  renderFlower();
  renderAdvice();
  renderPlan();
  renderRanking();
  renderTables();
  renderInvestment();
  renderFarm();
  renderSettings();
  renderEvents();
  renderCalendar();
  renderSell();
  renderHistory();
}

function buildInsights() {
  const farm = detected?.raw;
  const today = todayIn(detected?.timezone);
  const priceFn = (n) => result.price(n);
  const deliveries = farm ? analyzeDeliveries(farm, { price: priceFn, fee: result.fee, today }) : [];
  const reserved = reservedByDeliveries(deliveries);
  insights = {
    today,
    deliveries,
    inventory: farm ? analyzeInventory(farm, { price: priceFn, fee: result.fee, liquidity: state.liquidity, reserved, stats: history?.priceStats }) : { rows: [], total: 0 },
    events: farm ? upcomingEvents(farm, today) : [],
    monthEvents: farm ? upcomingEvents(farm, today.slice(0, 8) + "01", 60) : [],
    bounties: farm ? coinBounties(farm) : [],
    metrics: historyMetrics(history),
  };
}

let timer;
function recomputeSoon() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    saveState();
    recompute();
  }, 250);
}

function renderHeader() {
  const t = result.totals;
  $("#flowerPrice").textContent = t.flowerUsd ? `US$ ${fmt(t.flowerUsd, 4)}` : "sin precio";
  const who = detected?.username ? ` · ${detected.username}` : "";
  const when = farmPayload?.fetchedAt ? ` · ${new Date(farmPayload.fetchedAt).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}` : "";
  $("#farmLine").textContent = `Granja #${state.farmId}${who}${when}`;
}

// Explica por qué los datos de la granja no son recientes, usando el estado real del Worker.
function staleNote() {
  if (!farmStaleAt) return null;
  const cron = history?.cron || {};
  const err = String(cron.lastFarmError || "");
  const ageMs = Date.now() - Date.parse(farmStaleAt);
  let why;
  if (/429/.test(err)) why = "La API de Sunflower Land está limitando consultas y el Worker reintenta solo";
  else if (err) why = `El Worker no pudo actualizarlos (${err.split(". Próximo")[0].replace("https://api.sunflower-land.com", "")})`;
  else if (cron.lastRunAt && Date.now() - Date.parse(cron.lastRunAt) > 15 * 60e3) why = "El Worker no corrió en los últimos minutos: revisá el cron en Cloudflare";
  else if (!history) why = "No se pudo consultar el estado del Worker";
  else why = "El Worker todavía no los renovó";
  // Hasta 6 horas es solo un aviso: para planificar, la granja cambia despacio.
  return { text: `Mostrando datos de ${ago(farmStaleAt)}. ${why}.`, cls: ageMs > 6 * 3600e3 ? "err" : "ok" };
}

function renderStatus() {
  const rows = [];
  const stale = staleNote();
  if (stale) rows.push(stale);
  if (status.farm) rows.push({ text: status.farm, cls: /No se pudo/.test(status.farm) ? "err" : "ok" });
  if (status.market) rows.push({ text: status.market, cls: /No se|incompletos/.test(status.market) ? "err" : "ok" });
  $("#statusBar").innerHTML = rows.map((r) => `<div class="${r.cls}">${esc(r.text)}</div>`).join("");
}

function renderGoal(animate) {
  const t = result.totals;
  const input = $("#targetUsd");
  if (document.activeElement !== input) input.value = state.targetUsd;

  const proj = $("#projUsd");
  proj.textContent = t.usdMonth === null ? "–" : `US$ ${fmt(t.usdMonth, 2)}`;
  const ratio = t.usdMonth === null ? 0 : t.usdMonth / Math.max(1, state.targetUsd);
  proj.classList.toggle("ok", ratio >= 1);

  const cells = 20;
  const filled = Math.min(cells, ratio * cells);
  const meter = $("#plotMeter");
  meter.innerHTML = Array.from({ length: cells }, (_, i) => {
    if (i + 1 <= filled) return `<span class="plot fill" style="--i:${i}">${icon("Sunflower", { size: 40 })}</span>`;
    if (i < filled) return `<span class="plot part">${icon("sprout", { size: 40 })}</span>`;
    return `<span class="plot"></span>`;
  }).join("");
  meter.setAttribute("aria-label", `Avance: ${Math.round(ratio * 100)}% de la meta`);
  if (animate) {
    meter.classList.remove("grow");
    void meter.offsetWidth;
    meter.classList.add("grow");
  }

  const note = $("#goalNote");
  if (t.usdMonth === null) note.textContent = "Falta el precio de FLOWER para convertir a dólares. Cargalo a mano en Ajustes si la API no responde.";
  else if (ratio >= 1) note.textContent = `Cubrís el ${Math.round(ratio * 100)}% de la meta. Te sobran US$ ${fmt(t.usdMonth - state.targetUsd, 2)} por mes.`;
  else note.textContent = `Cubrís el ${Math.round(ratio * 100)}% de la meta. Faltan US$ ${fmt(state.targetUsd - t.usdMonth, 2)} por mes.`;

  $("#kFlowerDay").textContent = fmt(t.netFlowerDay, 2);
  $("#kNeeded").textContent = t.neededFlowerDay === null ? "–" : fmt(t.neededFlowerDay, 2);
  $("#kCoins").textContent = fmt(t.coinsDay, 0);
}

function compact(n) {
  if (!Number.isFinite(n)) return "–";
  if (n >= 1e6) return `${fmt(n / 1e6, 1)} M`;
  if (n >= 1e3) return `${fmt(n / 1e3, 1)} mil`;
  return fmt(n, 0);
}

function renderFlower() {
  const t = result.totals;
  const pair = market?.flowerPair;
  const arsRate = market?.ars?.compra;
  const manual = Number(state.flowerUsdOverride) > 0;

  $("#fUsd").textContent = t.flowerUsd ? `US$ ${fmt(t.flowerUsd, 4)}` : "Sin precio";
  $("#fArs").textContent = t.flowerUsd && arsRate ? `≈ $ ${fmt(t.flowerUsd * arsRate, 2)} ARS` : "";

  const ch = Number(pair?.change24h);
  const chEl = $("#fChange");
  chEl.textContent = !manual && Number.isFinite(ch) ? `${ch > 0 ? "+" : ""}${fmt(ch, 2)}% en 24 h` : manual ? "precio manual" : "";
  chEl.className = `chg ${!manual && ch > 0 ? "up" : !manual && ch < 0 ? "down" : ""}`;

  const stats = [];
  if (!manual && pair?.volume24hUsd != null) stats.push(["Volumen 24 h", `US$ ${compact(pair.volume24hUsd)}`]);
  if (!manual && pair?.liquidityUsd != null) stats.push([pair.pools > 1 ? `Liquidez (${pair.pools} pools)` : "Liquidez", `US$ ${compact(pair.liquidityUsd)}`]);
  if (detected?.flower != null && t.flowerUsd) {
    stats.push(["Tu saldo", `${fmt(detected.flower, 2)} FLOWER`]);
    stats.push(["Tu saldo vale", `US$ ${fmt(detected.flower * t.flowerUsd, 2)}`]);
    if (arsRate) stats.push(["En pesos", `$ ${fmt(detected.flower * t.flowerUsd * arsRate, 0)}`]);
  }
  if (arsRate) stats.push(["Tu meta en pesos", `$ ${fmt(state.targetUsd * arsRate, 0)}/mes`]);
  if (arsRate && t.usdMonth != null) stats.push(["Proyección en pesos", `$ ${fmt(t.usdMonth * arsRate, 0)}/mes`]);
  $("#fStats").innerHTML = stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");

  const notes = [];
  if (arsRate) notes.push(`Pesos calculados con el dólar ${market.ars.nombre.toLowerCase()} (compra: $ ${fmt(arsRate, 2)}).`);
  const mv = marketView();
  if (!manual && mv?.flowerSourceLabel) notes.push(`Fuente: ${mv.flowerSourceLabel} (cambiala en Ajustes).`);
  if (market?.fetchedAt) notes.push(`Actualizado ${ago(market.fetchedAt)}.`);
  $("#fNote").textContent = notes.join(" ");
}

function renderAdvice() {
  const t = result.totals;
  const items = [];
  const add = (html, kind = "", ico = kind === "bad" ? "Crimstone" : kind === "warn" ? "bell" : "sprout") =>
    items.push(`<li class="${kind}"><span class="ico">${CAT_OF[ico] ? ic(ico, 26) : icon(ico, { size: 26 })}</span><div>${html}</div></li>`);
  const usd = (flowerDay) => (t.usdPerFlower ? `≈ US$ ${fmt(flowerDay * 30 * t.usdPerFlower, 2)}/mes` : "");

  if (!detected) add("Todavía no hay datos de la granja. Tocá <strong>actualizar</strong> arriba o cargá el número en la pestaña Granja.", "warn");

  const good = result.streams.filter((s) => s.netFlowerDay > 0);
  const bad = result.streams.filter((s) => s.netFlowerDay <= 0);

  if (good.length) {
    const top = good[0];
    const share = t.netFlowerDay > 0 ? Math.round((top.netFlowerDay / t.netFlowerDay) * 100) : 0;
    add(`Tu recurso más rentable es <strong>${esc(label(top.name))}</strong>: ${fmt(top.netFlowerDay, 2)} FLOWER por día ${usd(top.netFlowerDay)}, el ${share}% de lo que genera la granja.`, "", top.name);
  }

  const cropsUsed = [...new Set(result.plan.map((p) => p.crop))];
  if (cropsUsed.length > 1) {
    add(`En las parcelas conviene rotar: <strong>${cropsUsed.map((c) => esc(label(c))).join(", ")}</strong> según el tiempo hasta tu próxima sesión. El plan del día está abajo.`, "", cropsUsed[0]);
  } else if (cropsUsed.length === 1) {
    add(`En las ${result.plots} parcelas conviene plantar solo <strong>${esc(label(cropsUsed[0]))}</strong>.`, "", cropsUsed[0]);
  }

  if (t.neededFlowerDay !== null && good.length) {
    if (t.netFlowerDay >= t.neededFlowerDay) {
      let acc = 0;
      const set = [];
      for (const s of good) {
        acc += s.netFlowerDay;
        set.push(s);
        if (acc >= t.neededFlowerDay) break;
      }
      add(`Para tu meta alcanza con vender <strong>${set.map((s) => esc(label(s.name))).join(" + ")}</strong>. Lo demás lo podés guardar, usar en recetas o vender si sube el precio.`, "", "trophy");
    } else {
      const gap = t.neededFlowerDay - t.netFlowerDay;
      add(`Te faltan <strong>${fmt(gap, 2)} FLOWER por día</strong> para llegar a US$ ${fmt(state.targetUsd, 0)}.`, "warn");
      if (state.sessions < 12) {
        const more = compute({ state, detected, market: marketView(), sessionsOverride: Math.min(12, state.sessions + 2) });
        const diff = more.totals.netFlowerDay - t.netFlowerDay;
        if (diff > 0.01) add(`Con 2 sesiones más por día sumarías ${fmt(diff, 2)} FLOWER diarios ${usd(diff)}.`, "warn");
      }
      const best = evaluateCandidates().filter((c) => c.delta > 0).sort((a, b) => a.payback - b.payback)[0];
      if (best) add(`De tus candidatos, <strong>${esc(best.name)}</strong> es el que antes se paga: ${fmt(best.payback, 0)} días.`, "warn");
      else add("Cargá en la pestaña Inversión los boosts que estés mirando para ver cuál acorta la distancia a la meta.", "warn");
    }
  }

  const m = insights.metrics;
  if (m && t.usdPerFlower) {
    const realUsd = m.earnedPerDay * 30 * t.usdPerFlower;
    add(
      `En los últimos ${fmt(m.span, 0)} días ganaste <strong>${fmt(m.earnedPerDay, 2)} FLOWER por día</strong> (≈ US$ ${fmt(realUsd, 2)}/mes) según los contadores del juego.${
        t.usdMonth ? ` El plan proyecta US$ ${fmt(t.usdMonth, 2)}/mes: ${realUsd >= t.usdMonth * 0.9 ? "vas en línea" : "hay margen para mejorar el ritmo"}.` : ""
      }`,
      realUsd >= state.targetUsd ? "" : "warn",
      "hourglass"
    );
  }
  const todayDouble = insights.events.find((e) => e.today && e.name === "doubleDelivery");
  const nextDouble = insights.events.find((e) => !e.today && e.name === "doubleDelivery");
  if (todayDouble) add("<strong>Hoy hay entregas dobles.</strong> Priorizá las entregas que pagan FLOWER antes de vender al Marketplace.", "", "calendar");
  else if (nextDouble) add(`Próximas entregas dobles: <strong>${esc(fmtDate(nextDouble.date))}</strong>. Conviene guardar ingredientes para ese día.`, "", "calendar");
  const bestDeliv = insights.deliveries.find((d) => d.kind === "flower" && d.margin > 0);
  if (bestDeliv) add(`La entrega de <strong>${esc(bestDeliv.from)}</strong> paga ${fmt(bestDeliv.rewardFlower, 2)} FLOWER, ${fmt(bestDeliv.margin, 2)} más que vender sus ingredientes. Detalle en Vender.`, "", "sack");
  if (insights.inventory.total > 0) {
    const top = insights.inventory.rows.slice(0, 3).map((r) => esc(label(r.item))).join(", ");
    add(`Tu inventario vendible vale unos <strong>${fmt(insights.inventory.total, 2)} FLOWER</strong>${t.usdPerFlower ? ` (≈ US$ ${fmt(insights.inventory.total * t.usdPerFlower, 2)})` : ""}. Lo de más valor: ${top}.`, "", insights.inventory.rows[0]?.item || "sack");
  }
  if (detected && t.coinsDay > 0) {
    const days = detected.coins / t.coinsDay;
    const netCoins = m ? m.coinsInPerDay - m.coinsOutPerDay : null;
    add(
      `Tus ${fmt(detected.coins, 0)} coins alcanzan para unos <strong>${fmt(days, 1)} días</strong> del plan.${
        netCoins !== null ? ` En la última semana tu saldo de coins ${netCoins >= 0 ? "subió" : "bajó"} ${fmt(Math.abs(netCoins), 0)} por día.` : ""
      }`,
      days < 3 ? "warn" : "",
      "coin"
    );
  }

  for (const s of result.streams.filter((x) => x.category === "crop" && x.seedsDay)) {
    const stock = Number(detected?.seedStock?.[`${s.name} Seed`]);
    if (stock > 0 && s.seedsDay > stock) {
      add(`El plan usa unas ${fmt(s.seedsDay, 0)} semillas de <strong>${esc(label(s.name))}</strong> por día y la tienda repone ${fmt(stock, 0)} por vez. Revisá cuántas tenés guardadas o mezclá con otro cultivo.`, "warn");
    }
  }
  for (const s of result.streams.filter((x) => x.overLiquidity)) {
    add(`Ojo con <strong>${esc(label(s.name))}</strong>: producirías ${fmt(s.unitsDay, 0)} por día y estimaste que el mercado absorbe ${fmt(s.overLiquidity, 0)}. Vender todo puede bajar el precio.`, "warn");
  }
  if (bad.length) {
    add(`No conviene vender <strong>${bad.map((s) => esc(label(s.name))).join(", ")}</strong>: los insumos cuestan igual o más de lo que cobrás. Usalos para crafteo o entregas.`, "bad");
  }
  if (result.missingPrices.length) {
    add(`Sin precio de mercado: ${result.missingPrices.map((n) => esc(label(n))).join(", ")}. Quedan fuera del cálculo hasta que cargues un precio manual.`, "warn");
  }
  if (!detected && t.coinsDay > 0 && !state.coinToFlower) {
    add(`Este plan consume unos <strong>${fmt(t.coinsDay, 0)} coins por día</strong> en semillas y herramientas.`);
  }

  $("#advice").innerHTML = items.join("") || `<li class="warn">Cargá tu granja y los precios para ver recomendaciones.</li>`;
}

function hhmm(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
}
function dur(min) {
  if (min < 60) return `${fmt(min, 0)} min`;
  const h = min / 60;
  return h < 48 ? `${fmt(h, h % 1 ? 1 : 0)} h` : `${fmt(h / 24, 1)} días`;
}

function renderPlan() {
  const plan = result.plan;
  $("#planHint").textContent = result.plots
    ? `Dos días de ejemplo con ${result.plots} parcelas y ${state.sessions} sesiones entre las ${state.firstHour}:00 y las ${state.lastHour}:00.`
    : "No hay parcelas detectadas.";
  if (!plan.length) {
    $("#plan").innerHTML = `<li class="muted">Sin plan: faltan parcelas o precios de cultivos.</li>`;
    return;
  }
  const offset = Math.floor(plan[0].minute / 1440);
  const day = (m) => Math.floor(m / 1440) - offset + 1;
  $("#plan").innerHTML = plan
    .map((p) => {
      const ready = day(p.readyMinute) === day(p.minute) ? hhmm(p.readyMinute) : `día ${day(p.readyMinute)}, ${hhmm(p.readyMinute)}`;
      return `<li>${ic(p.crop, 28)}<div><time>Día ${day(p.minute)} · ${hhmm(p.minute)}</time> Plantá <strong>${esc(label(p.crop))}</strong> en las parcelas libres <span class="muted">· listo ${ready}</span></div></li>`;
    })
    .join("");
  $("#plan").insertAdjacentHTML("beforeend", `<li class="muted">En las demás sesiones solo cosechás lo que esté listo. El ciclo se repite.</li>`);
}

function renderRanking() {
  const list = result.streams.filter((s) => rankFilter === "all" || s.category === rankFilter);
  const max = Math.max(...result.streams.map((s) => Math.abs(s.netFlowerDay)), 0.0001);
  const t = result.totals;
  $("#rankList").innerHTML = list.length
    ? list
        .map((s) => {
          const flags = [];
          if (s.timeSource === "real") flags.push(`<span class="flag real">tiempo real</span>`);
          if (s.timeSource === "real-general") flags.push(`<span class="flag real">tiempo real estimado</span>`);
          if (s.applied?.length) flags.push(...s.applied.map((b) => `<span class="flag boost">${esc(b)}</span>`));
          if (s.overLiquidity) flags.push(`<span class="flag">supera la liquidez estimada</span>`);
          if (s.unknownMats?.length) flags.push(`<span class="flag">sin precio: ${s.unknownMats.map(esc).join(", ")}</span>`);
          if (s.netFlowerDay <= 0) flags.push(`<span class="flag bad">no conviene vender</span>`);
          if (s.bestOf > 1) flags.push(`<span class="flag">mejor de ${s.bestOf} frutas</span>`);
          const usdM = t.usdPerFlower ? `US$ ${fmt(s.netFlowerDay * 30 * t.usdPerFlower, 2)}/mes` : "";
          return `<li>
            <span class="ico">${ic(s.name, 30)}</span>
            <div><div class="name">${esc(label(s.name))}</div><div class="cat">${CATEGORY_LABEL[s.category]} · ${s.nodes} ${unitWord(s.category)}</div></div>
            <div><div class="val ${s.netFlowerDay <= 0 ? "neg" : ""}">${fmt(s.netFlowerDay, 2)} <small>FLOWER/día</small></div><div class="usd">${usdM}</div></div>
            <div class="bar"><i style="width:${Math.max(0, (s.netFlowerDay / max) * 100)}%"></i></div>
            <div class="meta">${fmt(s.unitsDay, 1)} unidades/día a ${fmt(s.price, 4)} FLOWER · ciclo ${dur(s.cycleMin)} · ${esc(s.detail)}</div>
            ${flags.length ? `<div class="flags">${flags.join("")}</div>` : ""}
          </li>`;
        })
        .join("")
    : `<li class="empty">No hay recursos de este tipo con precio y cantidad.</li>`;
}

function unitWord(cat) {
  return { crop: "parcelas", fruit: "parches", node: "nodos", animal: "animales" }[cat];
}

function renderTables() {
  const head = `<thead><tr><th>Cultivo</th><th>Ciclo</th><th>Cosechas/día</th><th>Unid./día</th><th>FLOWER/día</th></tr></thead>`;
  $("#singleTbl").innerHTML = result.singleCrop.length
    ? head +
      "<tbody>" +
      result.singleCrop
        .map(
          (c, i) =>
            `<tr class="${i === 0 ? "top" : ""}"><td>${withIcon(c.name)}</td><td>${dur(c.cycleMin)}</td><td>${fmt(c.harvestsPerPlot, 2)}</td><td>${fmt(c.unitsDay, 1)}</td><td>${fmt(c.netFlowerDay, 2)}</td></tr>`
        )
        .join("") +
      "</tbody>"
    : `<tbody><tr><td>Sin datos de cultivos.</td></tr></tbody>`;

  $("#fruitTbl").innerHTML = result.fruitRank.length
    ? `<thead><tr><th>Fruta</th><th>Ciclo</th><th>Unid./día</th><th>FLOWER/día</th></tr></thead><tbody>` +
      result.fruitRank
        .map((f, i) => `<tr class="${i === 0 ? "top" : ""}"><td>${withIcon(f.name)}</td><td>${dur(f.cycleMin)}</td><td>${fmt(f.unitsDay, 1)}</td><td>${fmt(f.netFlowerDay, 2)}</td></tr>`)
        .join("") +
      "</tbody>"
    : `<tbody><tr><td>Sin parches de fruta o sin precios.</td></tr></tbody>`;
}

/* ---------- Calendario mensual ---------- */

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const WEEKDAYS = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"];

function renderCalendar() {
  const t = result.totals;
  const today = insights.today;
  if (!today) return;
  const monthKey = today.slice(0, 7);

  // Reinicio mensual: se borran las marcas de días de meses anteriores.
  const w = state.dayWeights || {};
  const kept = Object.fromEntries(Object.entries(w).filter(([d]) => d.startsWith(monthKey)));
  if (Object.keys(kept).length !== Object.keys(w).length) {
    state.dayWeights = kept;
    saveState();
  }

  const m = insights.metrics;
  const capacityUsdDay = t.usdPerFlower ? (m ? m.earnedPerDay * t.usdPerFlower : t.usdMonth != null ? t.usdMonth / 30 : null) : null;
  const cal = monthCalendar({
    history,
    today,
    goalUsd: state.targetUsd,
    usdPerFlowerNow: t.usdPerFlower,
    cashout: (state.cashoutFee || 0) / 100,
    weights: state.dayWeights || {},
    events: insights.monthEvents,
    capacityUsdDay,
  });
  insights.calendar = cal;
  if (!selectedDay || !selectedDay.startsWith(monthKey)) selectedDay = today;

  $("#calTitle").textContent = `${MONTHS[cal.month - 1]} ${cal.year}`;
  const progress = cal.earnedPast + cal.earnedToday;
  $("#calSum").textContent = `US$ ${fmt(progress, 2)} / ${fmt(cal.goal, 2)}`;

  const hints = [];
  if (!history) hints.push("El calendario usa el historial del Worker. Mientras no haya datos, muestra lo que tenés que hacer desde hoy.");
  if (cal.prorated) hints.push(`La meta de este mes se prorratea desde el día ${cal.startN}, el primero con datos.`);
  if (cal.forecast != null) {
    hints.push(
      cal.forecast >= cal.goal
        ? `Con tu ritmo ${m ? "real" : "proyectado"} cerrarías el mes en US$ ${fmt(cal.forecast, 2)}: llegás.`
        : `Con tu ritmo ${m ? "real" : "proyectado"} cerrarías el mes en US$ ${fmt(cal.forecast, 2)}: te faltarían US$ ${fmt(cal.goal - cal.forecast, 2)}.`
    );
  }
  hints.push("Tocá un día para ver el detalle o marcarlo como libre o fuerte.");
  $("#calHint").textContent = hints.join(" ");

  // Grilla (semana empieza el lunes)
  const firstWd = (new Date(cal.year, cal.month - 1, 1).getDay() + 6) % 7;
  let html = WEEKDAYS.map((d) => `<div class="cal-wd" role="columnheader">${d}</div>`).join("");
  html += Array.from({ length: firstWd }, () => `<div></div>`).join("");
  for (const d of cal.days) {
    const cls = [d.status];
    if (d.weight === 0 && (d.status === "future" || d.status === "today")) cls.push("off");
    if (d.demanding) cls.push("demanding");
    let ico = "";
    let amt = "";
    let extra = "";
    if (d.status === "done") { ico = icon("Sunflower", { size: 24 }); amt = fmt(d.earnedUsd, 2); }
    else if (d.status === "partial") { ico = icon("sprout", { size: 24 }); amt = fmt(d.earnedUsd, 2); }
    else if (d.status === "missed") { ico = icon("wilted", { size: 24 }); amt = fmt(d.earnedUsd, 2); }
    else if (d.status === "today-done") { ico = icon("Sunflower", { size: 24 }); amt = "¡Cumplido!"; }
    else if (d.status === "today") {
      ico = d.weight === 0 ? "" : icon("sprout", { size: 24 });
      amt = d.weight === 0 ? "libre" : fmt(d.targetUsd, 2);
      extra = d.weight === 0 ? "" : `<span class="prog"><i style="width:${Math.min(100, Math.round((d.ratio || 0) * 100))}%"></i></span>`;
    } else if (d.status === "future") {
      ico = d.events.some((e) => e.name === "doubleDelivery") ? icon("sack", { size: 20 }) : "";
      amt = d.weight === 0 ? "libre" : fmt(d.targetUsd, 2);
    }
    const wt = d.weight === 1.5 && (d.status === "future" || d.status === "today") ? `<span class="wt">×1,5</span>` : "";
    const label = `${d.n} de ${MONTHS[cal.month - 1]}: ${amt ? (amt === "libre" ? "libre" : `US$ ${amt}`) : "sin datos"}`;
    html += `<button type="button" class="cal-day ${cls.join(" ")}" data-day="${d.date}" role="gridcell" aria-selected="${d.date === selectedDay}" aria-label="${esc(label)}" ${d.status === "nodata" ? "disabled" : ""}>
      <span class="dn">${d.n}</span>${wt}${ico}<span class="amt">${esc(amt)}</span>${extra}</button>`;
  }
  $("#calGrid").innerHTML = html;

  $("#calLegend").innerHTML = [
    [icon("Sunflower", { size: 16 }), "Meta cumplida"],
    [icon("sprout", { size: 16 }), "Más de la mitad"],
    [icon("wilted", { size: 16 }), "No alcanzado"],
    [icon("sack", { size: 16 }), "Entregas dobles"],
    ["", "Montos en US$: lo ganado en días pasados y la meta en los que vienen"],
  ]
    .map(([i, l]) => `<span>${i}${l}</span>`)
    .join("");

  renderDayDetail(cal);
}

function renderDayDetail(cal) {
  const t = result.totals;
  const d = cal.days.find((x) => x.date === selectedDay);
  const el = $("#calDetail");
  if (!d) {
    el.innerHTML = "";
    return;
  }
  const title = `${d.n} de ${MONTHS[cal.month - 1]}`;
  const evs = d.events.map((e) => `<li>${icon(e.name === "doubleDelivery" ? "sack" : "bell", { size: 18 })}${esc(e.title)}: ${esc(e.note)}</li>`).join("");
  const segment = () => `<div class="seg" role="group" aria-label="Tipo de día">
      ${[[1, "Normal"], [1.5, "Fuerte ×1,5"], [0, "Libre"]]
        .map(([v, l]) => `<button type="button" data-weight="${v}" class="${d.weight === v ? "on" : ""}">${l}</button>`)
        .join("")}
    </div>`;
  let html = "";

  if (d.status === "nodata") {
    html = `<h4>${icon("calendar", { size: 20 })}${title}</h4><p>Sin registro: el Worker todavía no guardaba datos ese día.</p>`;
  } else if (["done", "partial", "missed"].includes(d.status)) {
    const msg = { done: "Meta del día cumplida.", partial: "Llegaste a más de la mitad de la meta del día.", missed: "No se alcanzó la meta del día. Lo faltante ya está repartido entre los días que quedan." }[d.status];
    html = `<h4>${icon(d.status === "done" ? "Sunflower" : d.status === "partial" ? "sprout" : "wilted", { size: 20 })}${title}</h4>
      <p>Ganaste <strong>${fmt(d.earnedFlower, 2)} FLOWER</strong> (≈ US$ ${fmt(d.earnedUsd, 2)}) contra una meta diaria de US$ ${fmt(cal.baseline, 2)}.</p>
      <p>${msg}${d.merged ? " Este día incluye datos de días anteriores sin registro." : ""}</p>${evs ? `<ul>${evs}</ul>` : ""}`;
  } else {
    const isToday = d.status === "today" || d.status === "today-done";
    if (d.weight === 0) {
      html = `<h4>${icon("calendar", { size: 20 })}${title}${isToday ? " · hoy" : ""}</h4><p>Marcado como <strong>libre</strong>: su parte de la meta se reparte en los demás días.</p>${evs ? `<ul>${evs}</ul>` : ""}${segment()}`;
    } else {
      const missingFlower = isToday && d.targetFlower != null ? Math.max(0, d.targetFlower - d.earnedFlower) : d.targetFlower;
      let todo = "";
      if (missingFlower > 0.01) {
        const cover = coverWithInventory(insights.inventory.rows, missingFlower);
        const deliv = insights.deliveries.filter((x) => x.kind === "flower" && x.margin > 0 && x.haveAll).slice(0, 2);
        const items = [
          ...deliv.map((x) => `<li>${icon("sack", { size: 18 })}Completá la entrega de <strong class="npc">${esc(x.from)}</strong>: ${fmt(x.rewardFlower, 2)} FLOWER</li>`),
          ...cover.picks.map((p) => `<li>${ic(p.item, 18)}Vendé <strong>${fmt(p.units, 0)} ${esc(label(p.item))}</strong> ≈ ${fmt(p.flower, 2)} FLOWER</li>`),
        ];
        const prodTop = result.streams.find((s) => s.netFlowerDay > 0);
        if (!isToday && prodTop) items.push(`<li>${ic(prodTop.name, 18)}Producí y vendé <strong>${esc(label(prodTop.name))}</strong>: tu plan rinde ${fmt(prodTop.netFlowerDay, 2)} FLOWER por día.</li>`);
        todo = `<p>${isToday ? "Para completar hoy" : "Para ese día"} podés:</p><ul>${items.join("")}</ul>${
          cover.short > 0.01 && isToday ? `<p class="hint">El inventario no alcanza para cubrir todo: faltarían ${fmt(cover.short, 2)} FLOWER de producción nueva.</p>` : ""
        }`;
      }
      const prog = isToday
        ? `<p>Llevás <strong>${fmt(d.earnedFlower, 2)} FLOWER</strong> de <strong>${fmt(d.targetFlower, 2)}</strong> (US$ ${fmt(d.earnedUsd, 2)} de ${fmt(d.targetUsd, 2)}).</p>
           <div class="bigbar"><i style="width:${Math.min(100, Math.round((d.ratio || 0) * 100))}%"></i></div>`
        : `<p>Meta del día: <strong>${fmt(d.targetFlower, 2)} FLOWER</strong> (≈ US$ ${fmt(d.targetUsd, 2)}).</p>`;
      const warn = d.demanding ? `<p class="hint">Es más de lo que venís ganando por día. Marcá algún día como fuerte o subí sesiones para repartir mejor.</p>` : "";
      html = `<h4>${icon(d.status === "today-done" ? "Sunflower" : "sprout", { size: 20 })}${title}${isToday ? " · hoy" : ""}</h4>${prog}${
        d.status === "today-done" ? "<p>¡Meta del día cumplida! Lo que sumes de más aliviana los días que vienen.</p>" : todo
      }${warn}${evs ? `<ul>${evs}</ul>` : ""}${segment()}`;
    }
  }
  el.innerHTML = html;
}

/* ---------- Eventos, Vender, Historial ---------- */

function fmtDate(iso) {
  const [y, mo, d] = iso.split("-").map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString("es-AR", { weekday: "short", day: "numeric", month: "short" });
}

function islandWindows() {
  const tz = detected?.timezone || "America/Argentina/Buenos_Aires";
  const hm = (ms) => new Date(ms).toLocaleTimeString("es-AR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return (detected?.raw?.floatingIsland?.schedule || [])
    .filter((w) => Number(w.endAt) > Date.now())
    .slice(0, 3)
    .map((w) => {
      const open = Number(w.startAt) <= Date.now();
      const day = todayIn(tz) === new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(w.startAt)) ? "Hoy" : "Mañana";
      return `<li class="${open ? "today" : ""}">${icon("island", { size: 22 })}<time>${open ? "Ahora" : day}</time><div>Isla flotante ${open ? "abierta" : "abre"} ${open ? `hasta las ${hm(w.endAt)}` : `de ${hm(w.startAt)} a ${hm(w.endAt)}`}<small>Te avisamos por Telegram 5 minutos antes.</small></div></li>`;
    })
    .join("");
}

function renderEvents() {
  const ev = insights.events;
  const isl = islandWindows();
  $("#events").innerHTML = isl + (ev.length
    ? ev
        .map((e) => {
          const evIcon = e.name === "doubleDelivery" ? "sack" : e.name === "bountifulHarvest" ? "Wheat" : e.name === "fullMoon" ? "flowerToken" : "bell";
          return `<li class="${e.today ? "today" : ""}">${icon(evIcon, { size: 22 })}<time>${e.today ? "Hoy" : esc(fmtDate(e.date))}</time><div>${esc(e.title)}<small>${esc(e.note)}</small></div></li>`;
        })
        .join("")
    : isl ? "" : `<li class="empty">Sin eventos en el calendario.</li>`);
}

function renderSell() {
  const t = result.totals;
  const usd = (f) => (t.usdPerFlower ? ` · US$ ${fmt(f * t.usdPerFlower, 2)}` : "");

  // Entregas
  const dl = insights.deliveries;
  const anyDouble = dl.some((d) => d.doubleToday);
  $("#delivHint").textContent = anyDouble
    ? "Hoy las entregas pagan el doble: los montos ya están duplicados."
    : "Compara lo que paga cada entrega con lo que cobrarías vendiendo los ingredientes en el Marketplace.";
  $("#delivList").innerHTML = dl.length
    ? dl
        .map((d) => {
          const needs = d.needs
            .map((n) => `<span class="need ${n.have < n.qty ? "miss" : ""}">${ic(n.item, 16)}${fmt(n.qty, 0)} ${esc(label(n.item))}${n.have < n.qty ? ` (tenés ${fmt(n.have, 0)})` : ""}</span>`)
            .join("");
          let reward;
          let cls = "neutral";
          let verdict = "";
          if (d.kind === "flower") {
            reward = `${fmt(d.rewardFlower, 2)} FLOWER`;
            if (d.margin === null) verdict = `${d.unpriced} ingrediente(s) sin precio de mercado (comidas o items de crafteo): calculá su costo a mano.`;
            else if (d.margin > 0) {
              cls = "good";
              verdict = `Conviene: ${fmt(d.margin, 2)} FLOWER más que vender los ingredientes${usd(d.margin)}.`;
            } else {
              cls = "bad";
              verdict = `No conviene: vendiendo los ingredientes cobrás ${fmt(-d.margin, 2)} FLOWER más.`;
            }
          } else if (d.kind === "coins") {
            reward = `${fmt(d.rewardCoins, 0)} coins`;
            verdict = d.ingredientValue > 0 ? `Los ingredientes valen ${fmt(d.ingredientValue, 2)} FLOWER en el Marketplace.` : "";
          } else if (d.kind === "items") {
            reward = Object.entries(d.rewardItems).map(([k, v]) => `${v} ${label(k)}`).join(", ");
          } else {
            reward = "tickets de temporada";
            verdict = d.ingredientValue > 0 ? `Los ingredientes valen ${fmt(d.ingredientValue, 2)} FLOWER: decidí si te interesan los tickets.` : "";
          }
          if (d.coinsCost) verdict += ` Además pide ${fmt(d.coinsCost, 0)} coins.`;
          const rIcon = d.kind === "flower" ? icon("flowerToken", { size: 20 }) : d.kind === "coins" ? icon("coin", { size: 20 }) : icon("sack", { size: 20 });
          return `<li class="${cls}"><div class="card-top"><strong class="npc">${esc(d.from)}</strong><span class="card-val">${rIcon}${esc(reward)}</span></div>
            <div>${needs}</div>${verdict ? `<small>${esc(verdict)}</small>` : ""}${!d.haveAll ? `<small>Te faltan ingredientes.</small>` : ""}</li>`;
        })
        .join("")
    : `<li class="empty">No hay entregas abiertas, o todavía no se cargó la granja.</li>`;

  // Inventario
  const inv = insights.inventory;
  const hasStats = !!history?.priceStats && Object.keys(history.priceStats).length > 0;
  $("#invHint").textContent = inv.rows.length
    ? `Valor neto de comisión: ${fmt(inv.total, 2)} FLOWER${usd(inv.total)}. Ya descuenta lo que piden las entregas que convienen.${
        hasStats ? " La señal compara el precio de hoy con el promedio de 7 días." : " Cuando haya historial de precios vas a ver si conviene vender ahora o esperar."
      }`
    : "Sin inventario con precio de mercado.";
  $("#invTbl").innerHTML = inv.rows.length
    ? `<thead><tr><th>Recurso</th><th>Vendible</th><th>Precio</th><th>Valor</th><th>Señal</th></tr></thead><tbody>` +
      inv.rows
        .slice(0, 25)
        .map((r) => {
          let sig = "";
          if (r.vsAvg !== null) {
            const pct = r.vsAvg * 100;
            sig =
              pct >= 5
                ? `<span class="sig up">+${fmt(pct, 0)}% · vender</span>`
                : pct <= -5
                  ? `<span class="sig down">${fmt(pct, 0)}% · esperar</span>`
                  : `<span class="sig">${fmt(pct, 0)}%</span>`;
          }
          const days = r.daysToSell ? ` <span class="src">(${fmt(r.daysToSell, 0)} días)</span>` : "";
          return `<tr><td>${withIcon(r.item)}</td><td>${fmt(r.sellable, 0)}${r.keep ? ` <span class="src">+${fmt(r.keep, 0)} reservado</span>` : ""}</td><td>${fmt(r.price, 4)}</td><td>${fmt(r.value, 2)}${days}</td><td>${sig}</td></tr>`;
        })
        .join("") +
      `</tbody>`
    : "";

  // Bounties
  const bt = insights.bounties;
  $("#bountyList").innerHTML = bt.length
    ? bt
        .map(
          (b) =>
            `<li><div class="card-top"><strong>${ic({ Chicken: "Egg", Cow: "Milk", Sheep: "Wool" }[b.name] || "sprout", 22)}${esc({ Chicken: "Gallina", Cow: "Vaca", Sheep: "Oveja" }[b.name] || b.name)}${b.level ? ` nivel ${b.level}` : ""}</strong><span class="card-val">${icon("coin", { size: 20 })}${fmt(b.coins, 0)} coins</span></div>
            <small>Tenés ${b.owned} de este tipo. Revisá en el juego si alguno llegó al nivel.</small></li>`
        )
        .join("")
    : `<li class="empty">No hay bounties con coins abiertas.</li>`;
}

function svgBars(data, { goal = null, h = 140 } = {}) {
  const w = 600;
  const pad = 22;
  const max = Math.max(goal || 0, ...data.map((d) => d.v), 0.0001);
  const bw = (w - pad * 2) / Math.max(1, data.length);
  const bars = data
    .map((d, i) => {
      const bh = Math.max(0, (d.v / max) * (h - pad * 2));
      return `<rect class="bar" x="${pad + i * bw + 2}" y="${h - pad - bh}" width="${Math.max(2, bw - 4)}" height="${bh}" rx="2"><title>${esc(d.label)}: ${fmt(d.v, 2)}</title></rect>`;
    })
    .join("");
  const goalY = goal ? h - pad - (goal / max) * (h - pad * 2) : null;
  const goalLine = goalY !== null ? `<line class="goal" x1="${pad}" x2="${w - pad}" y1="${goalY}" y2="${goalY}"/><text x="${w - pad}" y="${goalY - 4}" text-anchor="end">meta</text>` : "";
  const labels = data.length ? `<text x="${pad}" y="${h - 6}">${esc(data[0].label)}</text><text x="${w - pad}" y="${h - 6}" text-anchor="end">${esc(data[data.length - 1].label)}</text>` : "";
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Gráfico de barras">${bars}${goalLine}${labels}</svg>`;
}

function svgLine(points, { h = 120 } = {}) {
  if (points.length < 2) return "";
  const w = 600;
  const pad = 22;
  const xs = points.map((p) => p.t);
  const ys = points.map((p) => p.v);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (x) => pad + ((x - x0) / Math.max(1, x1 - x0)) * (w - pad * 2);
  const sy = (y) => h - pad - ((y - y0) / Math.max(1e-9, y1 - y0)) * (h - pad * 2);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Precio de FLOWER">
    <path class="line" d="${d}"/><text x="${pad}" y="14">máx US$ ${fmt(y1, 4)}</text><text x="${pad}" y="${h - 6}">mín US$ ${fmt(y0, 4)}</text></svg>`;
}

function renderHistory() {
  const body = $("#histBody");
  const hint = $("#histHint");
  if (!history) {
    hint.textContent = historyError.includes("D1")
      ? "Todavía no está conectada la base de historial. Seguí los pasos del README para crear la base D1 y desplegar el Worker programado."
      : `No se pudo leer el historial${historyError ? ` (${historyError})` : ""}.`;
    body.innerHTML = "";
    return;
  }
  const m = insights.metrics;
  const t = result.totals;
  const cron = history.cron || {};
  hint.textContent = m
    ? `Del ${fmtDate(m.firstDay)} al ${fmtDate(m.lastDay)}, medido con los contadores del juego. Última consulta del Worker: ${cron.lastFarmAt ? ago(cron.lastFarmAt) : "nunca"}.`
    : "El historial necesita al menos dos días de datos. El Worker guarda una foto por día: volvé mañana.";

  let html = "";
  if (m) {
    const usdM = (f) => (t.usdPerFlower ? `US$ ${fmt(f * 30 * t.usdPerFlower, 2)}/mes` : "–");
    html += `<dl class="hist-kpis">
      <div><dt>FLOWER ganado por día</dt><dd>${fmt(m.earnedPerDay, 2)}</dd></div>
      <div><dt>Equivale a</dt><dd>${usdM(m.earnedPerDay)}</dd></div>
      <div><dt>FLOWER gastado por día</dt><dd>${fmt(m.spentPerDay, 2)}</dd></div>
      <div><dt>Coins netos por día</dt><dd>${fmt(m.coinsInPerDay - m.coinsOutPerDay, 0)}</dd></div>
    </dl>`;
    if (m.daily.length) {
      const goalPerDay = t.neededFlowerDay;
      html += `<h3>FLOWER ganado por día</h3>${svgBars(m.daily.map((d) => ({ label: fmtDate(d.day), v: Math.max(0, d.earned) })), { goal: goalPerDay })}
        <p class="hint">La línea punteada es lo que necesitás por día para tu meta.</p>`;
    }

    // Ritmo real vs plan
    const plan = {};
    for (const s of result.streams) {
      const g = s.category === "crop" ? "crops" : s.category === "fruit" ? "fruits" : s.name;
      plan[g] = (plan[g] || 0) + (s.harvestsDay || 0);
    }
    const names = { crops: "Cultivos", fruits: "Frutas", Wood: "Árboles", Stone: "Piedra", Iron: "Hierro", Gold: "Oro", Crimstone: "Crimstone", Oil: "Petróleo", Egg: "Gallinas", Milk: "Vacas", Wool: "Ovejas" };
    const rows = Object.keys(names)
      .filter((g) => plan[g] > 0 || m.harvests[g] > 0)
      .map((g) => {
        const real = m.harvests[g];
        const p = plan[g] || 0;
        const eff = p > 0 && real !== null ? real / p : null;
        return `<tr><td>${names[g]}</td><td>${real === null ? "sin dato" : fmt(real, 1)}</td><td>${fmt(p, 1)}</td><td><span class="eff ${eff === null ? "" : eff < 0.8 ? "low" : "ok"}">${eff === null ? "–" : `${fmt(eff * 100, 0)}%`}</span></td></tr>`;
      })
      .join("");
    html += `<h3 class="mt">Ritmo de cosecha: real vs plan</h3>
      <p class="hint">Cosechas por día. Por debajo de 80% estás dejando ciclos sin cosechar: los avisos de Telegram ayudan a recuperarlos.</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Grupo</th><th>Real</th><th>Plan</th><th>Ritmo</th></tr></thead><tbody>${rows}</tbody></table></div>`;

    if (m.other.length) {
      html += `<h3 class="mt">Otras actividades por día</h3>
        <p class="hint">Pesca, miel, sal, excavación y demás. Todavía no se valúan: sirven para ver dónde va tu tiempo.</p>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Actividad</th><th>Por día</th></tr></thead><tbody>${m.other
          .map((o) => `<tr><td>${esc(o.key)}</td><td>${fmt(o.perDay, 1)}</td></tr>`)
          .join("")}</tbody></table></div>`;
    }
  }

  // Ventas cobradas
  const sales = history.sales || [];
  if (sales.length) {
    const net = sales.reduce((a, s) => a + (s.flower - s.tax), 0);
    const since30 = Date.now() - 30 * 86400e3;
    const net30 = sales.filter((s) => s.at >= since30).reduce((a, s) => a + (s.flower - s.tax), 0);
    html += `<h3 class="mt">Ventas cobradas en el Marketplace</h3>
      <p class="hint">Últimos 30 días: ${fmt(net30, 2)} FLOWER netos${t.usdPerFlower ? ` (≈ US$ ${fmt(net30 * t.usdPerFlower, 2)})` : ""}. Total registrado: ${fmt(net, 2)} FLOWER.</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Items</th><th>Neto</th></tr></thead><tbody>${sales
        .slice(0, 20)
        .map(
          (s) =>
            `<tr><td>${new Date(s.at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}</td><td>${esc(
              Object.entries(s.items).map(([k, v]) => `${v} ${label(k)}`).join(", ")
            )}</td><td>${fmt(s.flower - s.tax, 4)}</td></tr>`
        )
        .join("")}</tbody></table></div>`;
  }

  // FLOWER
  const fs = (history.flowerSeries || []).map((p) => ({ t: p.t, v: p.usd }));
  if (fs.length > 1) html += `<h3 class="mt">Precio de FLOWER (14 días)</h3>${svgLine(fs)}`;

  // Próximos avisos
  const tm = (history.timers || []).filter((x) => !x.notified).slice(0, 8);
  if (tm.length) {
    html += `<h3 class="mt">Próximos avisos</h3><ul class="events">${tm
      .map((x) => `<li>${icon("bell", { size: 22 })}<time>${new Date(x.readyAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}</time><div>${esc(x.label)}</div></li>`)
      .join("")}</ul>`;
  }

  body.innerHTML = html;
}

/* ---------- Inversión ---------- */

function evaluateCandidates() {
  const base = result.totals.netFlowerDay;
  const up = result.totals.usdPerFlower;
  return (state.candidates || []).map((c, idx) => {
    const r = compute({ state, detected, market: marketView(), extraBoosts: [c] });
    const delta = r.totals.netFlowerDay - base;
    return {
      ...c,
      idx,
      delta,
      deltaUsdMonth: up ? delta * 30 * up : null,
      payback: delta > 0 ? c.cost / delta : Infinity,
    };
  });
}

function renderInvestment() {
  const inp = $("#budgetUsd");
  if (document.activeElement !== inp) inp.value = state.budgetUsd;
  const fu = result.totals.flowerUsd;
  const budgetFlower = fu ? state.budgetUsd / fu : null;
  $("#budgetFlower").textContent = budgetFlower === null ? "" : `Equivale a unos ${fmt(budgetFlower, 0)} FLOWER por mes.`;

  const evals = evaluateCandidates();
  const ranked = [...evals].sort((a, b) => a.payback - b.payback);
  let spend = 0;
  const buy = new Set();
  for (const c of ranked) {
    if (c.payback <= 45 && budgetFlower !== null && spend + c.cost <= budgetFlower * 3) {
      spend += c.cost;
      buy.add(c.idx);
    }
  }

  $("#candList").innerHTML = ranked.length
    ? ranked
        .map((c) => {
          const months = budgetFlower ? Math.ceil(c.cost / Math.max(budgetFlower, 1e-9)) : null;
          let verdict;
          if (c.delta <= 0) verdict = "No mejora tu producción vendible.";
          else if (buy.has(c.idx)) verdict = `Conviene. Se paga en ${fmt(c.payback, 0)} días${months && months > 1 ? ` y lo juntás en ${months} meses de presupuesto` : ""}.`;
          else if (c.payback <= 90) verdict = `Se paga en ${fmt(c.payback, 0)} días. Dejalo para después de los prioritarios.`;
          else verdict = `Se paga recién en ${Number.isFinite(c.payback) ? fmt(c.payback, 0) : "∞"} días.`;
          return `<li class="${buy.has(c.idx) ? "buy" : ""}">
            <div><strong>${esc(c.name)}</strong><small>${fmt(c.cost, 0)} FLOWER · afecta a ${esc(targetLabel(c.targets[0]))} · ${esc(verdict)}</small></div>
            <div class="roi">${c.delta > 0 ? "+" : ""}${fmt(c.delta, 2)}/día<small>${c.deltaUsdMonth === null ? "" : `US$ ${fmt(c.deltaUsdMonth, 2)}/mes`}</small>
            <button class="btn ghost small" data-del-cand="${c.idx}" type="button">Quitar</button></div>
          </li>`;
        })
        .join("")
    : `<li class="empty">Todavía no cargaste candidatos.</li>`;
}

function targetOptions() {
  const groups = [
    ["crops", "Todos los cultivos"],
    ["fruits", "Todas las frutas"],
  ];
  const names = [...CROPS, ...FRUITS, ...NODES, ...ANIMALS].map((x) => [x.name, label(x.name)]);
  return [...groups, ...names].map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
}
function targetLabel(t) {
  return t === "crops" ? "todos los cultivos" : t === "fruits" ? "todas las frutas" : label(t);
}

function readBoostForm(form) {
  const fd = new FormData(form);
  return {
    name: String(fd.get("name")).trim(),
    targets: [String(fd.get("target"))],
    yieldPct: Number(fd.get("yieldPct")) || 0,
    yieldAdd: Number(fd.get("yieldAdd")) || 0,
    timePct: Number(fd.get("timePct")) || 0,
  };
}

/* ---------- Granja ---------- */

const COUNT_FIELDS = [
  ["crops", "Parcelas"],
  ["fruits", "Parches de fruta"],
  ["Wood", "Árboles"],
  ["Stone", "Piedras"],
  ["Iron", "Hierro"],
  ["Gold", "Oro"],
  ["Crimstone", "Crimstone"],
  ["Oil", "Pozos de petróleo"],
  ["Egg", "Gallinas"],
  ["Milk", "Vacas"],
  ["Wool", "Ovejas"],
];

function renderFarm() {
  const fid = $("#farmId");
  if (document.activeElement !== fid) fid.value = state.farmId;

  const facts = [];
  if (detected) {
    if (detected.username) facts.push(["Jugador", detected.username]);
    if (detected.season) facts.push(["Estación", SEASON_LABEL[detected.season] || detected.season]);
    if (detected.island) facts.push(["Isla", { basic: "Básica", spring: "Primavera", desert: "Desierto", volcano: "Volcán" }[detected.island] || detected.island]);
    facts.push(["Coins", fmt(detected.coins, 0)]);
    facts.push(["FLOWER en la granja", fmt(detected.flower, 2)]);
    if (detected.vipUntil) facts.push(["VIP hasta", new Date(detected.vipUntil).toLocaleDateString("es-AR")]);
    if (detected.marketFee != null) facts.push(["Comisión en tus ventas", `${fmt(detected.marketFee, 1)}%`]);
    if (detected.treeUnits && detected.treeUnits !== detected.counts.Wood)
      facts.push(["Árboles", `${detected.counts.Wood} (rinden como ${detected.treeUnits})`]);
  }
  $("#farmFacts").innerHTML = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");

  const grid = $("#countsGrid");
  if (!grid.contains(document.activeElement)) {
    grid.innerHTML = COUNT_FIELDS.map(([k, l]) => {
      const det = detected?.counts?.[k] ?? 0;
      const ov = state.countOverrides?.[k];
      return `<label class="field"><span>${esc(l)}</span><input type="number" min="0" step="1" data-count="${k}" placeholder="${det}" value="${ov ?? ""}"></label>`;
    }).join("");
  }

  const ag = $("#animalCfg");
  if (!ag.contains(document.activeElement)) {
    ag.innerHTML = ANIMALS.map((a) => {
      const c = { ...a, ...(state.animalCfg?.[a.name] || {}) };
      return `<label class="field"><span>${esc(label(a.name))} por animal/día</span><input type="number" step="any" min="0" data-animal="${a.name}" data-k="perDay" value="${c.perDay}"></label>
        <label class="field"><span>${esc(label(c.feedItem))} de alimento/día</span><input type="number" step="any" min="0" data-animal="${a.name}" data-k="feedQty" value="${c.feedQty}"></label>`;
    }).join("");
  }

  const active = result.boosts;
  const disabled = state.disabledBoosts || [];
  const autoDetected = detected
    ? BOOSTS.filter((b) => detected.placed.has(b.name) || detected.wearables.has(b.name) || detected.skills.has(b.name))
    : [];
  const rows = [
    ...active.filter((b) => b.source !== "simulado").map((b) => ({ ...b, on: true })),
    ...autoDetected.filter((b) => disabled.includes(b.name)).map((b) => ({ ...b, on: false, source: "auto" })),
  ];
  $("#boostList").innerHTML = rows.length
    ? rows
        .map((b) => {
          const eff = [
            b.yieldPct ? `${b.yieldPct > 0 ? "+" : ""}${b.yieldPct}% rendimiento` : "",
            b.yieldAdd ? `+${b.yieldAdd} por cosecha` : "",
            b.timePct ? `${b.timePct}% tiempo` : "",
          ]
            .filter(Boolean)
            .join(", ");
          const btn =
            b.source === "manual"
              ? `<button class="btn ghost small" data-del-boost="${esc(b.name)}" type="button">Quitar</button>`
              : `<button class="btn ghost small" data-toggle-boost="${esc(b.name)}" type="button">${b.on ? "Ignorar" : "Activar"}</button>`;
          return `<li style="${b.on ? "" : "opacity:.55"}"><div><strong>${esc(b.name)}</strong><small>${esc(targetLabel((b.targets || [])[0]))} · ${esc(eff)} · ${b.source === "manual" ? "manual" : "detectado"}</small></div>${btn}</li>`;
        })
        .join("")
    : `<li class="empty">No se detectaron boosts conocidos. Si tenés alguno, cargalo abajo.</li>`;

  const known = new Set(BOOSTS.map((b) => b.name).concat((state.customBoosts || []).map((b) => b.name)));
  const unknown = detected ? [...detected.recentBoosts].filter((n) => !known.has(n)).sort() : [];
  $("#unknownItems").innerHTML = unknown.length ? unknown.map((n) => `<span>${esc(n)}</span>`).join("") : `<span>Nada para mostrar.</span>`;

  const rows2 = result.streams
    .concat(result.singleCrop.filter((c) => !result.streams.some((s) => s.name === c.name)).map((c) => ({ ...c, category: "crop" })))
    .filter((s) => s.cycleMin);
  const base = Object.fromEntries([...CROPS, ...FRUITS, ...NODES].map((x) => [x.name, x.hours * 60]));
  const srcLabel = { real: "medido en tu granja", "real-general": "estimado con tus boosts generales", tabla: "tabla de boosts" };
  $("#timesTbl").innerHTML = rows2.length
    ? `<thead><tr><th>Recurso</th><th>Base</th><th>Tu ciclo</th><th>Fuente</th></tr></thead><tbody>` +
      rows2
        .map(
          (s) =>
            `<tr><td>${withIcon(s.name)}</td><td>${base[s.name] ? dur(base[s.name]) : "–"}</td><td>${dur(s.cycleMin)}</td><td class="src">${esc(srcLabel[s.timeSource] || "")}</td></tr>`
        )
        .join("") +
      `</tbody>`
    : `<tbody><tr><td>Cargá la granja para ver los tiempos.</td></tr></tbody>`;
}

/* ---------- Ajustes ---------- */

const ALL_PRICED = [...CROPS, ...FRUITS, ...NODES, ...ANIMALS].map((x) => x.name).concat(["Leather"]);

function renderSettings() {
  const setVal = (id, v) => {
    const el = $(id);
    if (document.activeElement !== el) el.value = v ?? "";
  };
  setVal("#sessions", state.sessions);
  $("#sessionsOut").textContent = state.sessions;
  setVal("#firstHour", state.firstHour);
  setVal("#lastHour", state.lastHour);
  setVal("#marketFee", state.marketFee);
  setVal("#cashoutFee", state.cashoutFee);
  setVal("#flowerUsdOverride", state.flowerUsdOverride ?? "");
  setVal("#coinToFlower", state.coinToFlower);
  $("#marketFeeAuto").checked = state.marketFeeAuto !== false;
  $("#marketFeeAutoLabel").textContent =
    detected?.marketFee != null
      ? `Usar la comisión real de mis ventas (${fmt(detected.marketFee, 1)}%) en vez del valor de arriba`
      : "Usar la comisión real de mis ventas (todavía no hay ventas detectadas)";
  $("#useObservedTimes").checked = state.useObservedTimes !== false;
  renderPools();
  const cron = history?.cron;
  $("#cronStatus").textContent = cron?.lastRunAt
    ? `Worker activo: última corrida ${ago(cron.lastRunAt)}, última consulta de la granja ${cron.lastFarmAt ? ago(cron.lastFarmAt) : "–"}.${cron.lastFarmError ? ` Último error: ${cron.lastFarmError}.` : ""}`
    : "Se activan al desplegar el Worker programado y conectar la base D1. Los pasos están en el README.";
  $("#rapidRoot").checked = !!result.rapidRoot;

  const season = detected?.season;
  $("#seasonHint").textContent = season
    ? `Estación detectada: ${SEASON_LABEL[season] || season}.${state.enabledCrops ? " Estás usando una selección manual." : " Se usan automáticamente sus cultivos."}`
    : "No se detectó la estación: se consideran todos los cultivos salvo que elijas cuáles.";
  const enabled = new Set(state.enabledCrops ?? (season && SEASON_CROPS[season] ? SEASON_CROPS[season] : CROPS.map((c) => c.name)));
  $("#cropToggles").innerHTML = CROPS.map(
    (c) => `<button type="button" data-crop="${c.name}" class="${enabled.has(c.name) ? "on" : ""}" aria-pressed="${enabled.has(c.name)}">${esc(label(c.name))}</button>`
  ).join("");

  const tbl = $("#priceTbl");
  if (!tbl.contains(document.activeElement)) {
    tbl.innerHTML =
      `<thead><tr><th>Recurso</th><th>Mercado</th><th>Manual</th><th>Liquidez/día</th></tr></thead><tbody>` +
      ALL_PRICED.map((n) => {
        const m = market?.prices?.[n];
        return `<tr><td>${withIcon(n)}</td><td>${Number.isFinite(m) ? fmt(m, 4) : `<span class="src">sin dato</span>`}</td>
          <td><input type="number" step="any" min="0" data-price="${n}" value="${state.priceOverrides?.[n] ?? ""}" aria-label="Precio manual de ${esc(label(n))}"></td>
          <td><input type="number" step="1" min="0" data-liq="${n}" value="${state.liquidity?.[n] ?? ""}" aria-label="Liquidez diaria de ${esc(label(n))}"></td></tr>`;
      }).join("") +
      `</tbody>`;
  }
}

function renderPools() {
  const box = $("#poolList");
  if (!box) return;
  const pools = market?.pools || [];
  const src = state.flowerSource || "auto";
  const manual = Number(state.flowerUsdOverride) > 0;
  if (!pools.length) {
    box.innerHTML = `<p class="hint">Todavía no hay datos de pools.</p>`;
    return;
  }
  const prices = pools.filter((p) => p.used).map((p) => p.priceUsd);
  const spread = prices.length > 1 ? Math.max(...prices) / Math.min(...prices) - 1 : 0;
  const opt = (value, title, sub, checked) =>
    `<label class="pool ${checked ? "on" : ""}"><input type="radio" name="flowerSource" value="${esc(value)}" ${checked ? "checked" : ""}><span><strong>${title}</strong><small>${sub}</small></span></label>`;
  let html = opt("auto", `Promedio de pools · US$ ${fmt(market.flowerUsd, 4)}`, "Ponderado por liquidez, solo pools con liquidez real. Recomendado.", src === "auto" && !manual);
  html += pools
    .map((p) =>
      opt(
        p.id,
        `${esc(p.dex)} ${esc(p.pair)} · US$ ${fmt(p.priceUsd, 4)}`,
        `Liquidez US$ ${compact(p.liquidityUsd)} · volumen 24 h US$ ${compact(p.volume24hUsd)}${p.used ? "" : " · poca liquidez, no entra en el promedio"}`,
        src === p.id && !manual
      )
    )
    .join("");
  box.innerHTML =
    html +
    (manual ? `<p class="hint">Ahora se usa tu precio manual (US$ ${fmt(Number(state.flowerUsdOverride), 4)}). Borralo para volver a estas fuentes.</p>` : "") +
    (spread > 0.15 ? `<p class="hint">Ojo: entre los pools hay hasta un ${fmt(spread * 100, 0)}% de diferencia. Usá el que se parezca más a lo que cobrás al vender.</p>` : "");
}

/* ---------- Eventos ---------- */

function bind() {
  const showTab = (tab) => {
    $$(".tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tab}`));
    window.scrollTo({ top: 0 });
  };
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#settingsBtn").addEventListener("click", () => showTab("ajustes"));

  $("#calGrid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-day]");
    if (!b || b.disabled) return;
    selectedDay = b.dataset.day;
    renderCalendar();
  });
  $("#calDetail").addEventListener("click", (e) => {
    const b = e.target.closest("[data-weight]");
    if (!b || !selectedDay) return;
    const v = Number(b.dataset.weight);
    state.dayWeights = { ...(state.dayWeights || {}), [selectedDay]: v };
    saveState();
    renderCalendar();
  });

  $("#refreshBtn").addEventListener("click", () => refreshAll(true));

  $("#targetUsd").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    if (v > 0) {
      state.targetUsd = v;
      recomputeSoon();
    }
  });
  $("#budgetUsd").addEventListener("input", (e) => {
    state.budgetUsd = Math.max(0, Number(e.target.value) || 0);
    recomputeSoon();
  });

  $("#rankFilter").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    rankFilter = b.dataset.f;
    $$("#rankFilter button").forEach((x) => x.classList.toggle("on", x === b));
    renderRanking();
  });

  $("#candTarget").innerHTML = targetOptions();
  $("#boostTarget").innerHTML = targetOptions();

  $("#candForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const b = readBoostForm(e.target);
    b.cost = Number(new FormData(e.target).get("cost")) || 0;
    if (!b.name) return;
    state.candidates.push(b);
    e.target.reset();
    saveState();
    recompute();
  });
  $("#candList").addEventListener("click", (e) => {
    const i = e.target.closest("[data-del-cand]")?.dataset.delCand;
    if (i === undefined) return;
    state.candidates.splice(Number(i), 1);
    saveState();
    recompute();
  });

  $("#boostForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const b = readBoostForm(e.target);
    if (!b.name) return;
    state.customBoosts = (state.customBoosts || []).filter((x) => x.name !== b.name).concat(b);
    e.target.reset();
    saveState();
    recompute();
  });
  $("#boostList").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del-boost]")?.dataset.delBoost;
    const tog = e.target.closest("[data-toggle-boost]")?.dataset.toggleBoost;
    if (del) state.customBoosts = state.customBoosts.filter((b) => b.name !== del);
    if (tog) {
      const set = new Set(state.disabledBoosts || []);
      set.has(tog) ? set.delete(tog) : set.add(tog);
      state.disabledBoosts = [...set];
    }
    if (del || tog) {
      saveState();
      recompute();
    }
  });

  $("#farmForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = Number($("#farmId").value);
    if (!(id > 0)) return;
    if (id !== state.farmId) {
      state.farmId = id;
      state.countOverrides = {};
      saveState();
    }
    await loadFarm(id, { force: true });
    recompute(true);
  });

  $("#countsGrid").addEventListener("input", (e) => {
    const k = e.target.dataset.count;
    if (!k) return;
    if (e.target.value === "") delete state.countOverrides[k];
    else state.countOverrides[k] = Math.max(0, Number(e.target.value) || 0);
    recomputeSoon();
  });
  $("#animalCfg").addEventListener("input", (e) => {
    const { animal, k } = e.target.dataset;
    if (!animal) return;
    state.animalCfg[animal] = { ...(state.animalCfg[animal] || {}), [k]: Math.max(0, Number(e.target.value) || 0) };
    recomputeSoon();
  });

  const numBind = (id, key, { min = 0, max = Infinity, allowEmpty = false } = {}) =>
    $(id).addEventListener("input", (e) => {
      if (allowEmpty && e.target.value === "") state[key] = null;
      else {
        const v = Number(e.target.value);
        if (!Number.isFinite(v)) return;
        state[key] = Math.min(max, Math.max(min, v));
      }
      if (key === "sessions") $("#sessionsOut").textContent = state.sessions;
      recomputeSoon();
    });
  numBind("#sessions", "sessions", { min: 1, max: 12 });
  numBind("#firstHour", "firstHour", { min: 0, max: 23 });
  numBind("#lastHour", "lastHour", { min: 0, max: 23 });
  numBind("#marketFee", "marketFee", { max: 100 });
  numBind("#cashoutFee", "cashoutFee", { max: 100 });
  numBind("#flowerUsdOverride", "flowerUsdOverride", { allowEmpty: true });
  numBind("#coinToFlower", "coinToFlower");

  for (const id of ["marketFeeAuto", "useObservedTimes", "rapidRoot"]) {
    $(`#${id}`).addEventListener("change", (e) => {
      state[id] = e.target.checked;
      saveState();
      recompute();
    });
  }

  $("#poolList").addEventListener("change", (e) => {
    if (e.target.name !== "flowerSource") return;
    state.flowerSource = e.target.value;
    state.flowerUsdOverride = null;
    saveState();
    recompute();
  });

  $("#cropToggles").addEventListener("click", (e) => {
    const c = e.target.closest("[data-crop]")?.dataset.crop;
    if (!c) return;
    const season = detected?.season;
    const cur = new Set(state.enabledCrops ?? (season && SEASON_CROPS[season] ? SEASON_CROPS[season] : CROPS.map((x) => x.name)));
    cur.has(c) ? cur.delete(c) : cur.add(c);
    state.enabledCrops = [...cur];
    saveState();
    recompute();
  });
  $("#autoSeason").addEventListener("click", () => {
    state.enabledCrops = null;
    saveState();
    recompute();
  });

  $("#priceTbl").addEventListener("input", (e) => {
    const p = e.target.dataset.price;
    const l = e.target.dataset.liq;
    if (p) {
      if (e.target.value === "") delete state.priceOverrides[p];
      else state.priceOverrides[p] = Number(e.target.value);
    }
    if (l) {
      if (e.target.value === "") delete state.liquidity[l];
      else state.liquidity[l] = Number(e.target.value);
    }
    recomputeSoon();
  });

  $("#pasteBtn").addEventListener("click", () => {
    try {
      const data = JSON.parse($("#pasteJson").value);
      farmPayload = { farmId: state.farmId, fetchedAt: new Date().toISOString(), data };
      writeLS(LS_FARM, farmPayload);
      detected = detectFarm(data);
      status.farm = "Granja cargada desde el JSON pegado.";
      recompute(true);
    } catch {
      status.farm = "No se pudo cargar: el texto pegado no es un JSON válido.";
      renderStatus();
    }
  });

  $("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dongranjero-ajustes-${state.farmId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#importFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      state = { ...clone(DEFAULTS), ...JSON.parse(await file.text()) };
      saveState();
      recompute(true);
      status.farm = "Ajustes importados.";
    } catch {
      status.farm = "El archivo no tiene ajustes válidos.";
    }
    renderStatus();
    e.target.value = "";
  });
  $("#resetBtn").addEventListener("click", () => {
    if (!confirm("Se borran tus ajustes, precios manuales, boosts y candidatos. ¿Seguir?")) return;
    state = clone(DEFAULTS);
    saveState();
    recompute(true);
  });
}

/* ---------- Inicio ---------- */

paintStaticIcons();
bind();
recompute(true);
refreshAll();
