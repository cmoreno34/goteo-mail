// Goteo Mail — panel (sin dependencias ni build).
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const main = $("#main");
let OV = null; // último /api/overview

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-goteo": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/login") { showLogin(); throw new Error("Sesión caducada"); }
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

const fmtDate = (ms) => ms ? new Date(ms).toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const rel = (ms) => {
  if (!ms) return "ya";
  const d = ms - Date.now();
  if (d <= 0) return "ya";
  const m = Math.round(d / 60000);
  return m < 60 ? `en ${m} min` : `en ${Math.round(m / 60)} h`;
};
const STATUS = { draft: "borrador", active: "activa", paused: "pausada", done: "terminada",
  pending: "pendiente", replied: "respondió", unsubscribed: "baja", bounced: "rebotó", skipped: "saltado", error: "apartado" };
const chip = (s) => `<span class="chip ${esc(s)}">${esc(STATUS[s] || s)}</span>`;
const PROV = { smtp: "SMTP", google: "Gmail (OAuth)", microsoft: "Outlook / 365" };

// ---------- Login ----------
function showLogin() { $("#login").classList.remove("hidden"); $("#app").classList.add("hidden"); }
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await api("POST", "/api/login", { password: $("#pw").value }); $("#login").classList.add("hidden"); boot(); }
  catch (err) { $("#loginErr").textContent = err.message; }
});
$("#logout").addEventListener("click", async () => { await api("POST", "/api/logout", {}); showLogin(); });

// ---------- Navegación ----------
async function boot() {
  try { OV = await api("GET", "/api/overview"); } catch { return showLogin(); }
  $("#app").classList.remove("hidden");
  route();
}
window.addEventListener("hashchange", route);
async function refresh() { OV = await api("GET", "/api/overview"); }

function route() {
  const [tab, id] = (location.hash.slice(1) || "resumen").split("/");
  document.querySelectorAll("header nav a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
  const views = { resumen: viewResumen, buzones: viewBuzones, contactos: viewContactos, campanas: id ? () => viewCampana(Number(id)) : viewCampanas };
  (views[tab] || viewResumen)().catch((e) => { main.innerHTML = `<div class="card err">${esc(e.message)}</div>`; });
}

// ---------- Resumen ----------
async function viewResumen() {
  await refresh();
  const alerts = [];
  for (const a of OV.accounts) if (a.last_error) alerts.push(`<div class="alert"><b>${esc(a.email)}</b> · ${a.fail_streak} fallos seguidos · ${esc(a.last_error)}</div>`);
  for (const c of OV.campaigns) if (c.stopped_reason && c.status === "paused") alerts.push(`<div class="alert warn"><b>${esc(c.name)}</b> está pausada: ${esc(c.stopped_reason)}</div>`);
  if (!OV.accounts.length) alerts.push(`<div class="note">Empieza conectando un buzón en <a href="#buzones">Buzones</a>.</div>`);
  const ct = OV.contacts || {};
  const active = OV.campaigns.filter((c) => c.status === "active");
  main.innerHTML = `
    ${alerts.join("")}
    <div class="card"><h2>Hoy</h2><div class="stats">
      <div class="stat"><b>${OV.accounts.reduce((s, a) => s + a.sent_24h, 0)}</b><span>enviados (24 h)</span></div>
      <div class="stat"><b>${active.length}</b><span>campañas activas</span></div>
      <div class="stat"><b>${ct.total || 0}</b><span>contactos</span></div>
      <div class="stat"><b>${ct.respuestas || 0}</b><span>respondieron</span></div>
      <div class="stat"><b>${ct.bajas || 0}</b><span>bajas</span></div>
      <div class="stat"><b>${ct.rebotes || 0}</b><span>rebotes</span></div>
    </div></div>
    <div class="grid2">
      <div class="card"><h2>Buzones</h2>${OV.accounts.map((a) => `
        <div class="list-item"><div><b>${esc(a.email)}</b><div class="muted small">${PROV[a.provider]} · ${a.sent_24h} en 24 h · ${a.active ? `próximo envío ${rel(a.next_at)}` : "desactivado"}</div></div>
        ${a.last_error ? '<span class="chip error">con fallos</span>' : a.active ? '<span class="chip active">ok</span>' : '<span class="chip">parado</span>'}</div>`).join("") || '<p class="muted">Ninguno.</p>'}</div>
      <div class="card"><h2>Campañas activas</h2>${active.map((c) => `
        <div class="list-item"><a href="#campanas/${c.id}">${esc(c.name)}</a><span class="muted small">${c.contacted}/${c.total} contactados · ${c.replied} resp. · ${c.clicked} clics</span></div>`).join("") || '<p class="muted">Ninguna.</p>'}</div>
    </div>
    <div class="card"><div class="row"><h2 style="flex:1">Actividad</h2><button class="fit small" id="tick">Ejecutar goteo ahora</button></div>
      <div class="tablewrap"><table><tbody>${OV.events.map((e) => `<tr><td class="muted small" style="white-space:nowrap">${fmtDate(e.at)}</td><td class="${e.level === "error" ? "err" : e.level === "warn" ? "warn" : ""}">${esc(e.message)}</td></tr>`).join("") || '<tr><td class="muted">Sin actividad todavía.</td></tr>'}</tbody></table></div></div>
    <div class="card"><h2>Ajustes</h2>
      <div class="row"><label>No volver a escribir a un contacto en (días), aunque esté en otra campaña<input type="number" id="cool" min="0" max="365" value="${OV.settings.cooldown_days}"></label><button class="fit" id="saveCool">Guardar</button></div>
    </div>`;
  $("#tick").onclick = async () => { const r = await api("POST", "/api/tick", {}); toast(`Pasada hecha: ${r.sent} enviado(s). ${(r.accounts || []).map((a) => a.why).filter(Boolean).join(" · ")}`, 7000); viewResumen(); };
  $("#saveCool").onclick = async () => { await api("PUT", "/api/settings", { cooldown_days: Number($("#cool").value) }); toast("Guardado"); };
}

// ---------- Buzones ----------
async function viewBuzones() {
  await refresh();
  main.innerHTML = `
    <div class="card"><h2>Conectar un buzón</h2>
      <div class="note">Gmail y Outlook con OAuth: el goteo además <b>detecta respuestas y rebotes</b> y deja de escribir a quien contesta. Con SMTP solo envía (las respuestas se marcan a mano).</div>
      <div class="row" style="margin:12px 0">
        <button class="fit" ${OV.oauth.google ? "" : "disabled title='Falta GOOGLE_CLIENT_ID'"} onclick="location.href='/oauth/google/start'">Conectar Gmail / Google Workspace</button>
        <button class="fit" ${OV.oauth.microsoft ? "" : "disabled title='Falta MS_CLIENT_ID'"} onclick="location.href='/oauth/microsoft/start'">Conectar Outlook / Microsoft 365</button>
      </div>
      <h3>O por SMTP (Gmail con contraseña de aplicación, dominio propio…)</h3>
      <form id="smtp" class="grid2">
        <label>Email<input name="email" type="email" required></label>
        <label>Nombre del remitente<input name="from_name" placeholder="Laura Pérez"></label>
        <label>Servidor<input name="host" value="smtp.gmail.com"></label>
        <label>Puerto<input name="port" type="number" value="465"></label>
        <label>Usuario (si no es el email)<input name="user"></label>
        <label>Contraseña de aplicación<input name="password" type="password" required></label>
        <div><button class="primary">Guardar buzón</button></div>
      </form>
      <p class="muted small">Gmail: <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">crear contraseña de aplicación</a> (requiere verificación en 2 pasos). Outlook ya no admite SMTP con contraseña: usa el botón de Outlook.</p>
    </div>
    ${OV.accounts.map((a) => `
    <div class="card" data-acc="${a.id}">
      <div class="row"><h2 style="flex:1">${esc(a.email)} <span class="muted small">${PROV[a.provider]}</span></h2>
        <span class="fit muted small">${a.sent_total} enviados · ${a.sent_24h} en 24 h · próximo ${a.active ? rel(a.next_at) : "—"}</span></div>
      ${a.last_error ? `<div class="alert">${esc(a.last_error)} <span class="muted">(${a.fail_streak} fallos seguidos)</span></div>` : ""}
      <div class="grid2">
        <label>Nombre del remitente<input data-f="from_name" value="${esc(a.from_name)}"></label>
        <label>Tope diario (máx. recomendado 40-50)<input data-f="daily_cap" type="number" min="1" max="500" value="${a.daily_cap}"></label>
        <label style="grid-column:1/-1">Firma (texto, va al final de cada correo)<textarea data-f="signature" style="min-height:80px">${esc(a.signature)}</textarea></label>
        <label class="check"><input type="checkbox" data-f="warmup" ${a.warmup ? "checked" : ""}> Calentamiento (empieza en 8/día y sube 4 cada día de envío)</label>
        <label class="check"><input type="checkbox" data-f="active" ${a.active ? "checked" : ""}> Activo</label>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="fit primary" data-act="save">Guardar</button>
        <input class="fit" style="max-width:240px" data-test placeholder="email para prueba">
        <button class="fit" data-act="test">Enviar prueba</button>
        <button class="fit danger ghost" data-act="del">Quitar</button>
      </div>
    </div>`).join("")}`;

  $("#smtp").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api("POST", "/api/accounts/smtp", f); toast("Buzón guardado. Manda una prueba antes de usarlo."); viewBuzones(); }
    catch (err) { toast(err.message); }
  };
  main.querySelectorAll("[data-acc]").forEach((card) => {
    const id = card.dataset.acc;
    card.onclick = async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      try {
        if (act === "save") {
          const body = {};
          card.querySelectorAll("[data-f]").forEach((el) => { body[el.dataset.f] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value; });
          await api("PATCH", `/api/accounts/${id}`, body); toast("Guardado");
        } else if (act === "test") {
          const to = $("[data-test]", card).value;
          e.target.disabled = true;
          await api("POST", `/api/accounts/${id}/test`, { to }); toast(`Prueba enviada a ${to}. Mira si llega a la bandeja principal.`, 6000);
        } else if (act === "del" && confirm("¿Quitar este buzón? Las campañas dejarán de usarlo.")) {
          await api("DELETE", `/api/accounts/${id}`); viewBuzones();
        }
      } catch (err) { toast(err.message, 8000); } finally { e.target.disabled = false; }
    };
  });
}

// ---------- CSV ----------
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const delim = (text.split("\n")[0].match(/;/g) || []).length > (text.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  const rows = []; let row = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); f = ""; if (row.some((x) => x.trim())) rows.push(row); row = [];
    } else f += c;
  }
  row.push(f); if (row.some((x) => x.trim())) rows.push(row);
  const head = (rows.shift() || []).map((h) => h.trim());
  return { head, rows: rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()]))) };
}

function guessCol(head, rows, kind) {
  const low = head.map((h) => h.toLowerCase());
  if (kind === "email") {
    const byName = low.findIndex((h) => /e-?mail|correo/.test(h));
    if (byName >= 0) return head[byName];
    return head.find((h) => rows.slice(0, 30).filter((r) => /@/.test(r[h] || "")).length >= 3) || "";
  }
  const i = low.findIndex((h) => /^(name|nombre|nombre completo|contacto|full name)$/.test(h));
  return i >= 0 ? head[i] : head[0] || "";
}

// ---------- Contactos ----------
async function viewContactos() {
  await refresh();
  main.innerHTML = `
    <div class="card"><h2>Importar CSV</h2>
      <p class="muted">En Notion: menú <b>···</b> de la base → <b>Export</b> → <i>Markdown &amp; CSV</i>. Sube el <code>.csv</code> (no el <code>_all.csv</code> si hay dos). Todas las columnas se guardan y sirven como huecos en la plantilla: <code>{Cargo}</code>, <code>{Ciudad}</code>, <code>{Tipo de empresa}</code>…</p>
      <div class="row"><input type="file" id="csv" accept=".csv,text/csv"><label>Nombre de la lista<input id="listName" placeholder="shamusic-mexico"></label></div>
      <div id="map"></div>
    </div>
    <div class="card"><div class="row"><h2 style="flex:1">Contactos</h2>
      <select class="fit" id="fList"><option value="">Todas las listas</option>${OV.lists.map((l) => `<option value="${esc(l.list)}">${esc(l.list)} (${l.n})</option>`).join("")}</select>
      <input class="fit" id="fq" placeholder="Buscar…" style="max-width:220px"></div>
      <div id="ctable" class="tablewrap"></div></div>`;

  let parsed = null;
  $("#csv").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    parsed = parseCSV(await file.text());
    if (!$("#listName").value) $("#listName").value = file.name.replace(/\.csv$/i, "").replace(/\s+[0-9a-f]{32}$/i, "").trim();
    const opt = (sel) => parsed.head.map((h) => `<option ${h === sel ? "selected" : ""}>${esc(h)}</option>`).join("");
    const em = guessCol(parsed.head, parsed.rows, "email"), nm = guessCol(parsed.head, parsed.rows, "name");
    $("#map").innerHTML = `
      <p>${parsed.rows.length} filas, ${parsed.head.length} columnas.</p>
      <div class="row"><label>Columna del email<select id="cEmail">${opt(em)}</select></label><label>Columna del nombre<select id="cName">${opt(nm)}</select></label></div>
      <p id="mapInfo" class="muted"></p><button class="primary" id="doImport">Importar</button>`;
    const info = () => {
      const c = $("#cEmail").value;
      const withEmail = parsed.rows.filter((r) => /@/.test(r[c] || "")).length;
      $("#mapInfo").innerHTML = `${withEmail} filas con email en «${esc(c)}». ${parsed.rows.length - withEmail ? `<span class="warn">${parsed.rows.length - withEmail} sin email se ignorarán</span> (p. ej. contactos solo de LinkedIn).` : ""}`;
    };
    $("#cEmail").onchange = info; info();
    $("#doImport").onclick = async () => {
      const ce = $("#cEmail").value, cn = $("#cName").value;
      const rows = parsed.rows.filter((r) => (r[ce] || "").trim()).map((r) => {
        const fields = { ...r }; delete fields[ce];
        return { email: r[ce], name: r[cn] || "", fields };
      });
      try {
        const res = await api("POST", "/api/contacts/import", { list: $("#listName").value, rows });
        toast(`${res.added} nuevos, ${res.updated} actualizados${res.invalid.length ? `, ${res.invalid.length} con email no válido` : ""}.`, 7000);
        if (res.invalid.length) $("#map").innerHTML = `<div class="alert warn">Emails descartados (no se pueden enviar): ${res.invalid.map(esc).join(", ")}</div>`;
        else $("#map").innerHTML = "";
        await refresh(); loadTable();
      } catch (err) { toast(err.message); }
    };
  };

  const loadTable = async () => {
    const qs = new URLSearchParams({ list: $("#fList").value, q: $("#fq").value });
    const { contacts } = await api("GET", `/api/contacts?${qs}`);
    $("#ctable").innerHTML = `<table><thead><tr><th>Nombre</th><th>Email</th><th>Lista</th><th>Estado</th><th>Último envío</th><th></th></tr></thead><tbody>${contacts.map((c) => {
      const st = c.unsubscribed_at ? chip("unsubscribed") : c.bounced_at ? chip("bounced") : c.replied_at ? chip("replied") : "";
      const f = JSON.parse(c.fields || "{}");
      const sub = [f["Cargo"], f["Empresa"] || f["Compañía"], f["Tipo de empresa"]].filter(Boolean).join(" · ");
      return `<tr><td>${esc(c.name)}<div class="muted small">${esc(sub)}</div></td><td>${esc(c.email)}</td><td class="muted">${esc(c.list)}</td><td>${st}</td><td class="muted">${fmtDate(c.last_contacted_at)}</td>
        <td>${c.replied_at ? "" : `<button class="small ghost" data-mark="${c.id}">Marcar respondido</button>`}</td></tr>`;
    }).join("")}</tbody></table>${contacts.length >= 500 ? '<p class="muted small">Mostrando 500. Usa el buscador.</p>' : ""}`;
    $("#ctable").querySelectorAll("[data-mark]").forEach((b) => b.onclick = async () => { await api("POST", `/api/contacts/${b.dataset.mark}/mark`, { kind: "replied" }); toast("Marcado: no recibirá más seguimientos"); loadTable(); });
  };
  $("#fList").onchange = loadTable;
  let t; $("#fq").oninput = () => { clearTimeout(t); t = setTimeout(loadTable, 300); };
  loadTable();
}

// ---------- Campañas ----------
async function viewCampanas() {
  await refresh();
  main.innerHTML = `
    <div class="card"><div class="row"><h2 style="flex:1">Campañas</h2><input class="fit" id="newName" placeholder="Nombre de la campaña" style="max-width:260px"><button class="fit primary" id="newCamp">Crear</button></div>
    <div class="tablewrap"><table><thead><tr><th>Campaña</th><th>Estado</th><th>Contactados</th><th>Pendientes</th><th>Respuestas</th><th>Clics</th><th>Bajas</th><th>Rebotes</th></tr></thead><tbody>
    ${OV.campaigns.map((c) => `<tr><td><a href="#campanas/${c.id}">${esc(c.name)}</a></td><td>${chip(c.status)}</td><td>${c.contacted}/${c.total}</td><td>${c.pending}</td><td>${c.replied}</td><td>${c.clicked}</td><td>${c.unsubscribed}</td><td>${c.bounced}</td></tr>`).join("") || '<tr><td colspan="8" class="muted">Aún no hay campañas.</td></tr>'}
    </tbody></table></div></div>`;
  $("#newCamp").onclick = async () => { const r = await api("POST", "/api/campaigns", { name: $("#newName").value }); location.hash = `campanas/${r.id}`; };
}

const DEFAULT_BODY = `{Hola|Buenos días|Qué tal} {nombre}:

Te escribo porque …

{Un saludo|Saludos|Gracias de antemano},
{remitente}`;

async function viewCampana(id) {
  await refresh();
  const { campaign: c, steps, perStep } = await api("GET", `/api/campaigns/${id}`);
  const accIds = JSON.parse(c.account_ids || "[]");
  const days = c.days || "12345";
  const sentBy = Object.fromEntries(perStep.map((p) => [p.step, p.n]));
  if (!steps[0].body) steps[0].body = DEFAULT_BODY;
  const locked = c.status === "active";

  main.innerHTML = `
    <p><a href="#campanas">← Campañas</a></p>
    ${c.stopped_reason && c.status === "paused" ? `<div class="alert warn">${esc(c.stopped_reason)}</div>` : ""}
    <div class="card"><div class="row"><h1 style="flex:1">${esc(c.name)} ${chip(c.status)}</h1>
      ${c.status === "active" ? '<button class="fit" data-status="paused">Pausar</button>' : '<button class="fit primary" data-status="active">Activar goteo</button>'}
      <button class="fit danger ghost" id="delCamp">Borrar</button></div>
      <div class="stats" style="margin-top:12px">
        <div class="stat"><b>${c.contacted}/${c.total}</b><span>contactados</span></div>
        <div class="stat"><b>${c.emails_sent}</b><span>correos enviados</span></div>
        <div class="stat"><b>${c.pending}</b><span>pendientes</span></div>
        <div class="stat"><b>${c.replied}</b><span>respondieron</span></div>
        <div class="stat"><b>${c.clicked}</b><span>hicieron clic</span></div>
        <div class="stat"><b>${c.unsubscribed}</b><span>bajas</span></div>
        <div class="stat"><b>${c.bounced}</b><span>rebotes</span></div>
        <div class="stat"><b>${c.set_aside}</b><span>apartados</span></div>
      </div>
    </div>

    <div class="card"><h2>Ajustes</h2>
      <div class="grid2">
        <label>Nombre<input id="cName" value="${esc(c.name)}"></label>
        <label>Zona horaria<input id="cTz" value="${esc(c.tz)}"></label>
        <label>Desde (hora)<input id="cWs" type="number" min="0" max="23" value="${c.window_start}"></label>
        <label>Hasta (hora)<input id="cWe" type="number" min="1" max="24" value="${c.window_end}"></label>
      </div>
      <h3>Días de envío</h3><div class="days">${["L", "M", "X", "J", "V", "S", "D"].map((d, i) => `<label><input type="checkbox" data-day="${i + 1}" ${days.includes(String(i + 1)) ? "checked" : ""}>${d}</label>`).join("")}</div>
      <h3>Buzones que envían (se reparten la lista; cada contacto recibe todo el hilo del mismo buzón)</h3>
      <div>${OV.accounts.map((a) => `<label class="check"><input type="checkbox" data-accid="${a.id}" ${accIds.includes(a.id) ? "checked" : ""}> ${esc(a.email)} <span class="muted small">(${a.daily_cap}/día${a.warmup ? ", calentando" : ""})</span></label>`).join("") || '<p class="muted">Conecta un buzón primero.</p>'}</div>
      <h3>Enlaces</h3>
      <div class="grid2">
        <label>Enlace principal — lo que vale <code>{enlace}</code><input id="cLink" value="${esc(c.main_link)}" placeholder="https://docs.google.com/presentation/…"></label>
        <label class="check" style="align-self:end"><input type="checkbox" id="cTrack" ${c.track_links ? "checked" : ""}> Seguimiento de clics (reescribe los enlaces por el dominio del goteo)</label>
      </div>
    </div>

    <div class="card"><h2>Secuencia</h2>
      <div class="note">Variantes con <code>{opción A|opción B}</code> (cada contacto recibe una, siempre la misma). Huecos: <code>{nombre}</code> (nombre de pila), <code>{nombre_completo}</code>, <code>{remitente}</code>, <code>{enlace}</code> y cualquier columna del CSV, p. ej. <code>{Cargo}</code>. Si un contacto no tiene el dato, se le salta. Los seguimientos solo salen si no ha contestado y van en el mismo hilo (asunto vacío = «Re: …»).</div>
      <div id="steps"></div>
      <button id="addStep">+ Añadir seguimiento</button>
      <div class="row" style="margin-top:12px"><button class="fit primary" id="saveCamp">Guardar</button><span class="muted small" id="saveInfo"></span></div>
      <h3>Vista previa</h3><div id="preview" class="muted">Pulsa «Vista previa» en un paso.</div>
    </div>

    <div class="card"><h2>Añadir contactos</h2>
      <div class="row"><label>Lista<select id="eList"><option value="">Todas</option>${OV.lists.map((l) => `<option value="${esc(l.list)}">${esc(l.list)} (${l.n})</option>`).join("")}</select></label>
        <label>No incluir a quien se escribió hace menos de (días)<input id="eSkip" type="number" min="0" value="30"></label></div>
      <div class="filters" id="filters"></div>
      <div class="row"><button class="fit" id="addInc">+ Solo si…</button><button class="fit" id="addExc">+ Excluir si…</button></div>
      <div class="row" style="margin-top:12px"><button class="fit" id="dry">Contar</button><button class="fit primary" id="enroll">Añadir a la campaña</button><span id="dryInfo" class="muted"></span></div>
      <p class="muted small">Ya quedan fuera siempre: bajas, rebotes, quien ha respondido y quien ya está en esta campaña. El orden se baraja para no escribir seguidos a gente de la misma empresa.</p>
    </div>

    <div class="card"><div class="row"><h2 style="flex:1">Destinatarios</h2>
      <select class="fit" id="rStatus"><option value="">Todos</option>${["pending", "done", "replied", "unsubscribed", "bounced", "skipped", "error"].map((s) => `<option value="${s}">${STATUS[s]}</option>`).join("")}</select></div>
      <div id="recips" class="tablewrap"></div></div>`;

  // --- Pasos
  const stepEl = (s, i) => `
    <div class="step" data-i="${i}">
      <div class="row"><b class="fit">${i === 0 ? "Correo 1" : `Seguimiento ${i}`}</b>
        ${i > 0 ? `<label class="fit">días después del anterior<input type="number" min="1" data-k="delay_days" value="${s.delay_days || 3}" style="width:80px"></label>` : ""}
        <span class="muted small fit">${sentBy[i + 1] ? `${sentBy[i + 1]} enviados` : ""}</span>
        ${i > 0 ? '<button class="fit small danger ghost" data-rm>Quitar</button>' : ""}</div>
      <input data-k="subject" placeholder="${i === 0 ? "Asunto (admite {variantes|distintas})" : "Asunto (vacío = responde en el mismo hilo)"}" value="${esc(s.subject)}">
      <textarea data-k="body">${esc(s.body)}</textarea>
      <div><button class="small" data-prev>Vista previa</button></div>
    </div>`;
  let stepsData = steps.map((s) => ({ delay_days: s.delay_days, subject: s.subject, body: s.body }));
  const readSteps = () => { $("#steps").querySelectorAll(".step").forEach((el) => { const i = Number(el.dataset.i); el.querySelectorAll("[data-k]").forEach((f) => stepsData[i][f.dataset.k] = f.dataset.k === "delay_days" ? Number(f.value) : f.value); }); };
  const drawSteps = () => {
    $("#steps").innerHTML = stepsData.map(stepEl).join("");
    $("#steps").querySelectorAll("[data-rm]").forEach((b) => b.onclick = () => { readSteps(); stepsData.splice(Number(b.closest(".step").dataset.i), 1); drawSteps(); });
    $("#steps").querySelectorAll("[data-prev]").forEach((b) => b.onclick = async () => {
      readSteps(); const i = Number(b.closest(".step").dataset.i);
      const r = await api("POST", `/api/campaigns/${id}/preview`, { step: stepsData[i], ord: i + 1, main_link: $("#cLink").value, account_id: currentAccounts()[0] });
      $("#preview").innerHTML = `<p class="small">Para <b>${esc(r.to)}</b> · ${r.variants} combinación(es) distintas${r.variants < 4 ? ' <span class="warn">— pocas; añade variantes {a|b} para que no salgan todos iguales</span>' : ""}</p>
        ${r.missing.length ? `<div class="alert warn">A este contacto le falta: ${r.missing.map((m) => `{${esc(m)}}`).join(", ")} → se le saltaría.</div>` : ""}
        <div class="preview"><b>Asunto:</b> ${esc(r.subject)}\n\n${esc(r.text)}</div>`;
    });
  };
  drawSteps();
  $("#addStep").onclick = () => { readSteps(); stepsData.push({ delay_days: 4, subject: "", body: "{Hola|Buenas} de nuevo, {nombre}:\n\n…" }); drawSteps(); };

  const currentAccounts = () => [...main.querySelectorAll("[data-accid]")].filter((x) => x.checked).map((x) => Number(x.dataset.accid));
  $("#saveCamp").onclick = async () => {
    readSteps();
    try {
      const r = await api("PUT", `/api/campaigns/${id}`, {
        name: $("#cName").value, account_ids: currentAccounts(), tz: $("#cTz").value,
        window_start: Number($("#cWs").value), window_end: Number($("#cWe").value),
        days: [...main.querySelectorAll("[data-day]")].filter((x) => x.checked).map((x) => x.dataset.day).join(""),
        track_links: $("#cTrack").checked, main_link: $("#cLink").value, steps: stepsData,
      });
      $("#saveInfo").textContent = `Guardado · variantes por paso: ${r.variants.join(", ")}`;
      toast("Campaña guardada");
    } catch (err) { toast(err.message); }
  };
  if (locked) $("#saveInfo").textContent = "La campaña está activa: los cambios valen para los próximos envíos.";

  main.querySelectorAll("[data-status]").forEach((b) => b.onclick = async () => {
    try { if (b.dataset.status === "active") $("#saveCamp").click(); await api("POST", `/api/campaigns/${id}/status`, { status: b.dataset.status }); viewCampana(id); }
    catch (err) { toast(err.message, 6000); }
  });
  $("#delCamp").onclick = async () => { if (confirm("¿Borrar la campaña y su historial?")) { await api("DELETE", `/api/campaigns/${id}`); location.hash = "campanas"; } };

  // --- Filtros de audiencia
  let columns = {};
  const loadCols = async () => { columns = (await api("GET", `/api/contacts/columns?list=${encodeURIComponent($("#eList").value)}`)).columns; };
  await loadCols();
  $("#eList").onchange = async () => { await loadCols(); $("#filters").innerHTML = ""; };
  const addFilter = (kind) => {
    const keys = Object.keys(columns).filter((k) => columns[k].length <= 60);
    if (!keys.length) return toast("No hay columnas con valores repetidos para filtrar");
    const div = document.createElement("div");
    div.className = "row"; div.dataset.kind = kind;
    div.innerHTML = `<span class="fit">${kind === "include" ? "Solo si" : "Excluir si"}</span>
      <select data-col>${keys.map((k) => `<option>${esc(k)}</option>`).join("")}</select>
      <select data-vals multiple size="4"></select><button class="fit small ghost" data-x>✕</button>`;
    const fill = () => { $("[data-vals]", div).innerHTML = columns[$("[data-col]", div).value].map((v) => `<option value="${esc(v.value)}">${esc(v.value || "(vacío)")} (${v.n})</option>`).join(""); };
    $("[data-col]", div).onchange = fill; fill();
    $("[data-x]", div).onclick = () => div.remove();
    $("#filters").appendChild(div);
  };
  $("#addInc").onclick = () => addFilter("include");
  $("#addExc").onclick = () => addFilter("exclude");
  const filterBody = () => {
    const f = { list: $("#eList").value, include: [], exclude: [], skip_contacted_days: Number($("#eSkip").value) || 0 };
    $("#filters").querySelectorAll("[data-kind]").forEach((d) => f[d.dataset.kind].push({ field: $("[data-col]", d).value, values: [...$("[data-vals]", d).selectedOptions].map((o) => o.value) }));
    return f;
  };
  $("#dry").onclick = async () => { const r = await api("POST", `/api/campaigns/${id}/enroll`, { ...filterBody(), dry_run: true }); $("#dryInfo").textContent = `${r.count} contactos${r.sample.length ? ` (p. ej. ${r.sample.slice(0, 3).join(", ")})` : ""}`; };
  $("#enroll").onclick = async () => {
    const d = await api("POST", `/api/campaigns/${id}/enroll`, { ...filterBody(), dry_run: true });
    if (!d.count) return toast("Ningún contacto cumple el filtro");
    if (!confirm(`¿Añadir ${d.count} contactos a «${c.name}»?`)) return;
    const r = await api("POST", `/api/campaigns/${id}/enroll`, filterBody());
    toast(`${r.added} añadidos`); viewCampana(id);
  };

  // --- Destinatarios
  const loadRecips = async () => {
    const { recipients } = await api("GET", `/api/campaigns/${id}/recipients?status=${$("#rStatus").value}`);
    $("#recips").innerHTML = `<table><thead><tr><th>Contacto</th><th>Estado</th><th>Paso</th><th>Último envío</th><th>Buzón</th><th>Clics</th><th></th></tr></thead><tbody>${recipients.map((r) => `
      <tr><td>${esc(r.name)}<div class="muted small">${esc(r.email)}</div></td><td>${chip(r.status)}${r.last_error ? `<div class="small muted">${esc(r.last_error)}</div>` : ""}</td>
      <td>${r.status === "pending" ? `${r.next_step}${r.due_at > Date.now() ? ` <span class="muted small">${fmtDate(r.due_at)}</span>` : ""}` : "—"}</td>
      <td class="muted">${fmtDate(r.last_sent)}</td><td class="muted small">${esc(r.account_email || "")}</td><td>${r.clicks || ""}</td>
      <td>${["error", "skipped"].includes(r.status) ? `<button class="small ghost" data-retry="${r.id}">Reintentar</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">Nadie todavía.</td></tr>'}</tbody></table>`;
    $("#recips").querySelectorAll("[data-retry]").forEach((b) => b.onclick = async () => { await api("POST", `/api/campaigns/${id}/enrollments/${b.dataset.retry}/retry`, {}); loadRecips(); });
  };
  $("#rStatus").onchange = loadRecips;
  loadRecips();
}

boot();
