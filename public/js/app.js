import { CROPS, FRUITS, NODES, ANIMALS, BOOSTS, DEFAULTS, LABELS, CATEGORY_LABEL, SEASON_CROPS, SEASON_LABEL } from "./data.js";
import { compute, detectFarm, fmt } from "./engine.js";

const LS_STATE = "dongranjero:state:v1";
const LS_FARM = "dongranjero:farm:v1";
const LS_MARKET = "dongranjero:market:v1";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const label = (n) => LABELS[n] || n;
const clone = (o) => JSON.parse(JSON.stringify(o));

let state = loadState();
let farmPayload = readLS(LS_FARM); // { fetchedAt, data }
let market = readLS(LS_MARKET); // { prices, flowerUsd, ... }
let detected = farmPayload ? detectFarm(farmPayload.data) : null;
let result = null;
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

async function loadFarm(id) {
  status.farm = `Cargando granja #${id}…`;
  renderStatus();
  try {
    const res = await fetch(`/api/farm/${encodeURIComponent(id)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error([body.error, body.hint].filter(Boolean).join(" ") || `Error ${res.status}`);
    farmPayload = { fetchedAt: body.fetchedAt, data: body.data };
    writeLS(LS_FARM, farmPayload);
    detected = detectFarm(body.data);
    status.farm = "";
  } catch (err) {
    status.farm = `No se pudo cargar la granja: ${err.message.replace(/\.+$/, "")}. Podés cargar las cantidades a mano en la pestaña Granja.`;
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

async function refreshAll() {
  const btn = $("#refreshBtn");
  btn.classList.add("spin");
  btn.disabled = true;
  await Promise.all([loadFarm(state.farmId), loadMarket()]);
  btn.classList.remove("spin");
  btn.disabled = false;
  recompute(true);
}

/* ---------- Cálculo y render ---------- */

function recompute(animate = false) {
  result = compute({ state, detected, market });
  renderHeader();
  renderStatus();
  renderGoal(animate);
  renderAdvice();
  renderPlan();
  renderRanking();
  renderTables();
  renderInvestment();
  renderFarm();
  renderSettings();
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

function renderStatus() {
  const msgs = [status.farm, status.market].filter(Boolean);
  $("#statusBar").innerHTML = msgs.map((m) => `<div class="${/No se|incompletos/.test(m) ? "err" : "ok"}">${esc(m)}</div>`).join("");
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
    if (i + 1 <= filled) return `<span class="plot fill" style="--i:${i}"></span>`;
    if (i < filled) return `<span class="plot part" style="--p:${Math.round((filled - i) * 100)}%"></span>`;
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

function renderAdvice() {
  const t = result.totals;
  const items = [];
  const add = (html, kind = "") => items.push(`<li class="${kind}">${html}</li>`);
  const usd = (flowerDay) => (t.usdPerFlower ? `≈ US$ ${fmt(flowerDay * 30 * t.usdPerFlower, 2)}/mes` : "");

  if (!detected) add("Todavía no hay datos de la granja. Tocá <strong>actualizar</strong> arriba o cargá el número en la pestaña Granja.", "warn");

  const good = result.streams.filter((s) => s.netFlowerDay > 0);
  const bad = result.streams.filter((s) => s.netFlowerDay <= 0);

  if (good.length) {
    const top = good[0];
    const share = t.netFlowerDay > 0 ? Math.round((top.netFlowerDay / t.netFlowerDay) * 100) : 0;
    add(`Tu recurso más rentable es <strong>${esc(label(top.name))}</strong>: ${fmt(top.netFlowerDay, 2)} FLOWER por día ${usd(top.netFlowerDay)}, el ${share}% de lo que genera la granja.`);
  }

  const cropsUsed = [...new Set(result.plan.map((p) => p.crop))];
  if (cropsUsed.length > 1) {
    add(`En las parcelas conviene rotar: <strong>${cropsUsed.map((c) => esc(label(c))).join(", ")}</strong> según el tiempo hasta tu próxima sesión. El plan del día está abajo.`);
  } else if (cropsUsed.length === 1) {
    add(`En las ${result.plots} parcelas conviene plantar solo <strong>${esc(label(cropsUsed[0]))}</strong>.`);
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
      add(`Para tu meta alcanza con vender <strong>${set.map((s) => esc(label(s.name))).join(" + ")}</strong>. Lo demás lo podés guardar, usar en recetas o vender si sube el precio.`);
    } else {
      const gap = t.neededFlowerDay - t.netFlowerDay;
      add(`Te faltan <strong>${fmt(gap, 2)} FLOWER por día</strong> para llegar a US$ ${fmt(state.targetUsd, 0)}.`, "warn");
      if (state.sessions < 12) {
        const more = compute({ state, detected, market, sessionsOverride: Math.min(12, state.sessions + 2) });
        const diff = more.totals.netFlowerDay - t.netFlowerDay;
        if (diff > 0.01) add(`Con 2 sesiones más por día sumarías ${fmt(diff, 2)} FLOWER diarios ${usd(diff)}.`, "warn");
      }
      const best = evaluateCandidates().filter((c) => c.delta > 0).sort((a, b) => a.payback - b.payback)[0];
      if (best) add(`De tus candidatos, <strong>${esc(best.name)}</strong> es el que antes se paga: ${fmt(best.payback, 0)} días.`, "warn");
      else add("Cargá en la pestaña Inversión los boosts que estés mirando para ver cuál acorta la distancia a la meta.", "warn");
    }
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
  if (t.coinsDay > 0 && !state.coinToFlower) {
    add(`Este plan consume unos <strong>${fmt(t.coinsDay, 0)} coins por día</strong> en semillas y herramientas. Verificá que tus entregas o ventas a Betty los cubran.`);
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
      return `<li><time>Día ${day(p.minute)} · ${hhmm(p.minute)}</time> Plantá <strong>${esc(label(p.crop))}</strong> en las parcelas libres <span class="muted">· listo ${ready}</span></li>`;
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
            `<tr class="${i === 0 ? "top" : ""}"><td>${esc(label(c.name))}</td><td>${dur(c.cycleMin)}</td><td>${fmt(c.harvestsPerPlot, 2)}</td><td>${fmt(c.unitsDay, 1)}</td><td>${fmt(c.netFlowerDay, 2)}</td></tr>`
        )
        .join("") +
      "</tbody>"
    : `<tbody><tr><td>Sin datos de cultivos.</td></tr></tbody>`;

  $("#fruitTbl").innerHTML = result.fruitRank.length
    ? `<thead><tr><th>Fruta</th><th>Ciclo</th><th>Unid./día</th><th>FLOWER/día</th></tr></thead><tbody>` +
      result.fruitRank
        .map((f, i) => `<tr class="${i === 0 ? "top" : ""}"><td>${esc(label(f.name))}</td><td>${dur(f.cycleMin)}</td><td>${fmt(f.unitsDay, 1)}</td><td>${fmt(f.netFlowerDay, 2)}</td></tr>`)
        .join("") +
      "</tbody>"
    : `<tbody><tr><td>Sin parches de fruta o sin precios.</td></tr></tbody>`;
}

/* ---------- Inversión ---------- */

function evaluateCandidates() {
  const base = result.totals.netFlowerDay;
  const up = result.totals.usdPerFlower;
  return (state.candidates || []).map((c, idx) => {
    const r = compute({ state, detected, market, extraBoosts: [c] });
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
            `<tr><td>${esc(label(s.name))}</td><td>${base[s.name] ? dur(base[s.name]) : "–"}</td><td>${dur(s.cycleMin)}</td><td class="src">${esc(srcLabel[s.timeSource] || "")}</td></tr>`
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
        return `<tr><td>${esc(label(n))}</td><td>${Number.isFinite(m) ? fmt(m, 4) : `<span class="src">sin dato</span>`}</td>
          <td><input type="number" step="any" min="0" data-price="${n}" value="${state.priceOverrides?.[n] ?? ""}" aria-label="Precio manual de ${esc(label(n))}"></td>
          <td><input type="number" step="1" min="0" data-liq="${n}" value="${state.liquidity?.[n] ?? ""}" aria-label="Liquidez diaria de ${esc(label(n))}"></td></tr>`;
      }).join("") +
      `</tbody>`;
  }
}

/* ---------- Eventos ---------- */

function bind() {
  $$(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
      $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${b.dataset.tab}`));
      window.scrollTo({ top: 0 });
    })
  );

  $("#refreshBtn").addEventListener("click", refreshAll);

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
    await loadFarm(id);
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
      farmPayload = { fetchedAt: new Date().toISOString(), data };
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

bind();
recompute(true);
refreshAll();
