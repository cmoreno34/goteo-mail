import type { Env } from "./env.ts";
import { encrypt, randomToken, sign, verify } from "./crypto.ts";
import { loadAccount, logEvent, markContact, runTick } from "./drip.ts";
import { newMessageId } from "./mime.ts";
import { oauthConfig, sendMessage, whoAmI } from "./providers.ts";
import { cleanEmail, escapeHtml, render, spintaxVariants } from "./template.ts";
import { compose, type ComposeCampaign } from "./compose.ts";

// Imágenes: solo formatos que ven todos los clientes de correo (Outlook no ve WebP).
const IMG_TYPES = ["image/png", "image/jpeg", "image/gif"];
const IMG_MAX_BYTES = 400 * 1024;

type Handler = (req: Request, env: Env, p: Record<string, string>, url: URL) => Promise<Response>;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

function page(title: string, inner: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f6f6f4;color:#222;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
.c{background:#fff;border:1px solid #e3e3df;border-radius:12px;padding:28px;max-width:420px;text-align:center}button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#222;color:#fff;cursor:pointer}</style>
</head><body><div class="c">${inner}</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

// ---------- Sesión del panel ----------
const SESSION_MS = 14 * 86_400_000;

async function isAdmin(req: Request, env: Env): Promise<boolean> {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)gm_s=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return verify(`s:${exp}`, sig, env.ADMIN_PASSWORD + env.ENC_KEY);
}

async function sessionCookie(env: Env): Promise<string> {
  const exp = String(Date.now() + SESSION_MS);
  const sig = await sign(`s:${exp}`, env.ADMIN_PASSWORD + env.ENC_KEY);
  return `gm_s=${encodeURIComponent(`${exp}.${sig}`)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`;
}

// ---------- Rutas públicas ----------
const BOT_UA = /bot|crawler|spider|preview|scanner|safelinks|barracuda|mimecast|proofpoint|curl|python|go-http/i;

const trackLink: Handler = async (req, env, p) => {
  const row = await env.DB.prepare("SELECT url FROM links WHERE code = ?").bind(p.code).first<{ url: string }>();
  if (!row) return page("Enlace no encontrado", "<p>Este enlace ya no existe.</p>", 404);
  const ua = req.headers.get("user-agent") || "";
  if (!BOT_UA.test(ua) && req.method === "GET") {
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE links SET clicks = clicks + 1, first_click_at = COALESCE(first_click_at, ?), last_click_at = ? WHERE code = ?",
    )
      .bind(now, now, p.code)
      .run();
  }
  return Response.redirect(row.url, 302);
};

async function unsubscribeByToken(env: Env, token: string): Promise<string | null> {
  const e = await env.DB.prepare(
    "SELECT e.contact_id, c.email FROM enrollments e JOIN contacts c ON c.id = e.contact_id WHERE e.token = ?",
  )
    .bind(token)
    .first<{ contact_id: number; email: string }>();
  if (!e) return null;
  await markContact(env, e.contact_id, "unsubscribed", Date.now(), `Baja: ${e.email}`);
  return e.email;
}

const unsubPage: Handler = async (req, env, p) => {
  if (req.method === "POST") {
    // One-click (RFC 8058) desde Gmail/Outlook, o el botón de esta página.
    const email = await unsubscribeByToken(env, p.token);
    if (!email) return page("Baja", "<p>Enlace no válido.</p>", 404);
    return page("Baja confirmada", `<h2>Listo</h2><p>${escapeHtml(email)} no recibirá más correos nuestros.</p>`);
  }
  // GET no da de baja solo: los antivirus de correo abren todos los enlaces.
  return page(
    "Darse de baja",
    `<h2>¿Dejar de recibir correos?</h2><p>Pulsa el botón para confirmar.</p><form method="post"><button>Darme de baja</button></form>`,
  );
};

// ---------- OAuth ----------
const oauthStart: Handler = async (_req, env, p) => {
  const prov = p.provider as "google" | "microsoft";
  const cfg = oauthConfig(env, prov);
  if (!cfg.clientId) return page("Falta configurar", `<p>Falta el client id de ${prov} en los secretos del Worker.</p>`, 500);
  const state = `${Date.now()}.${randomToken(8)}`;
  const u = new URL(cfg.authUrl);
  u.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: `${env.PUBLIC_URL}/oauth/${prov}/callback`,
    response_type: "code",
    scope: cfg.scope,
    state: `${state}.${await sign(state, env.ENC_KEY)}`,
    ...cfg.extra,
  }).toString();
  return Response.redirect(u.toString(), 302);
};

const oauthCallback: Handler = async (_req, env, p, url) => {
  const prov = p.provider as "google" | "microsoft";
  const cfg = oauthConfig(env, prov);
  const [ts, nonce, sig] = (url.searchParams.get("state") || "").split(".");
  if (!sig || !(await verify(`${ts}.${nonce}`, sig, env.ENC_KEY)) || Date.now() - Number(ts) > 15 * 60_000) {
    return page("Error", "<p>La conexión ha caducado. Vuelve a intentarlo desde el panel.</p>", 400);
  }
  const code = url.searchParams.get("code");
  if (!code) return page("Cancelado", `<p>${escapeHtml(url.searchParams.get("error_description") || "No se concedió el permiso.")}</p>`, 400);
  const r = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${env.PUBLIC_URL}/oauth/${prov}/callback`,
    }),
  });
  const j = (await r.json()) as { access_token?: string; refresh_token?: string; error_description?: string };
  if (!r.ok || !j.access_token || !j.refresh_token) {
    return page("Error", `<p>No se pudo conectar: ${escapeHtml(j.error_description || String(r.status))}</p>`, 400);
  }
  const email = await whoAmI(prov, j.access_token);
  if (!email) return page("Error", "<p>No se pudo leer la dirección del buzón.</p>", 400);
  const secret = await encrypt(j.refresh_token, env.ENC_KEY);
  await env.DB.prepare(
    `INSERT INTO accounts (provider, email, secret_enc, created_at) VALUES (?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET provider=excluded.provider, secret_enc=excluded.secret_enc,
       fail_streak=0, last_error=NULL, next_at=0, alert_sent_at=NULL`,
  )
    .bind(prov, email, secret, Date.now())
    .run();
  await logEvent(env, `Buzón conectado: ${email} (${prov})`);
  return Response.redirect(`${env.PUBLIC_URL}/#buzones`, 302);
};

// ---------- API del panel ----------
const api: Record<string, Handler> = {};
const route = (method: string, path: string, h: Handler) => (api[`${method} ${path}`] = h);

route("POST", "/api/login", async (req, env) => {
  const { password } = (await req.json()) as { password?: string };
  if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) return bad("Contraseña incorrecta", 401);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json", "set-cookie": await sessionCookie(env) },
  });
});

route("POST", "/api/logout", async () =>
  new Response("{}", { headers: { "content-type": "application/json", "set-cookie": "gm_s=; Path=/; Max-Age=0" } }),
);

route("GET", "/api/overview", async (_req, env) => {
  const now = Date.now();
  const accounts = (
    await env.DB.prepare(
      `SELECT a.id, a.provider, a.email, a.from_name, a.signature, a.signature_image_id, a.signature_width, a.smtp_host, a.smtp_port, a.daily_cap, a.warmup,
         a.active, a.next_at, a.fail_streak, a.last_error,
         (SELECT COUNT(*) FROM sends s WHERE s.account_id = a.id AND s.sent_at > ?) AS sent_24h,
         (SELECT COUNT(*) FROM sends s WHERE s.account_id = a.id) AS sent_total
       FROM accounts a ORDER BY a.id`,
    )
      .bind(now - 86_400_000)
      .all()
  ).results;
  const campaigns = (await env.DB.prepare(`SELECT c.*, ${CAMP_STATS} FROM campaigns c ORDER BY c.id DESC`).all()).results;
  const events = (await env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 40").all()).results;
  const contacts = await env.DB.prepare(
    `SELECT COUNT(*) total, SUM(unsubscribed_at IS NOT NULL) bajas, SUM(bounced_at IS NOT NULL) rebotes,
       SUM(replied_at IS NOT NULL) respuestas FROM contacts`,
  ).first();
  const lists = (await env.DB.prepare("SELECT list, COUNT(*) n FROM contacts GROUP BY list ORDER BY list").all()).results;
  const cooldown = await env.DB.prepare("SELECT value FROM settings WHERE key='cooldown_days'").first<{ value: string }>();
  return json({
    now,
    accounts,
    campaigns,
    events,
    contacts,
    lists,
    settings: { cooldown_days: Number(cooldown?.value ?? 7) },
    oauth: { google: Boolean(env.GOOGLE_CLIENT_ID), microsoft: Boolean(env.MS_CLIENT_ID) },
    public_url: env.PUBLIC_URL,
  });
});

const CAMP_STATS = `
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id) AS total,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id AND e.status = 'pending') AS pending,
  (SELECT COUNT(DISTINCT e.id) FROM enrollments e JOIN sends s ON s.enrollment_id = e.id WHERE e.campaign_id = c.id) AS contacted,
  (SELECT COUNT(*) FROM sends s JOIN enrollments e ON e.id = s.enrollment_id WHERE e.campaign_id = c.id) AS emails_sent,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id AND e.status = 'replied') AS replied,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id AND e.status = 'unsubscribed') AS unsubscribed,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id AND e.status = 'bounced') AS bounced,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id = c.id AND e.status IN ('error','skipped')) AS set_aside,
  (SELECT COUNT(DISTINCT l.enrollment_id) FROM links l JOIN enrollments e ON e.id = l.enrollment_id
     WHERE e.campaign_id = c.id AND l.clicks > 0) AS clicked`;

route("PUT", "/api/settings", async (req, env) => {
  const b = (await req.json()) as { cooldown_days?: number };
  const v = Math.max(0, Math.min(365, Number(b.cooldown_days ?? 7)));
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cooldown_days', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(String(v))
    .run();
  return json({ ok: true });
});

// --- Buzones
route("POST", "/api/accounts/smtp", async (req, env) => {
  const b = (await req.json()) as Record<string, string>;
  const email = cleanEmail(b.email || "");
  if (!email || !b.password) return bad("Faltan email o contraseña");
  const host = (b.host || "smtp.gmail.com").trim();
  const port = Number(b.port || 465);
  await env.DB.prepare(
    `INSERT INTO accounts (provider, email, from_name, smtp_host, smtp_port, smtp_user, secret_enc, created_at)
     VALUES ('smtp',?,?,?,?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET provider='smtp', from_name=excluded.from_name, smtp_host=excluded.smtp_host,
       smtp_port=excluded.smtp_port, smtp_user=excluded.smtp_user, secret_enc=excluded.secret_enc,
       fail_streak=0, last_error=NULL, next_at=0, alert_sent_at=NULL`,
  )
    .bind(email, b.from_name || "", host, port, b.user || email, await encrypt(b.password.replace(/\s+/g, ""), env.ENC_KEY), Date.now())
    .run();
  await logEvent(env, `Buzón SMTP conectado: ${email}`);
  return json({ ok: true });
});

route("PATCH", "/api/accounts/:id", async (req, env, p) => {
  const b = (await req.json()) as Record<string, unknown>;
  const allowed = ["from_name", "signature", "daily_cap", "warmup", "active", "signature_image_id", "signature_width"];
  if ("signature_image_id" in b && (b.signature_image_id === "" || b.signature_image_id === undefined)) b.signature_image_id = null;
  if ("signature_width" in b) b.signature_width = Math.max(80, Math.min(640, Number(b.signature_width) || 420));
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of allowed) {
    if (k in b) {
      sets.push(`${k} = ?`);
      vals.push(k === "daily_cap" ? Math.max(1, Math.min(500, Number(b[k]))) : typeof b[k] === "boolean" ? Number(b[k]) : b[k]);
    }
  }
  if ("active" in b && b.active) sets.push("fail_streak = 0, next_at = 0, alert_sent_at = NULL");
  if (!sets.length) return bad("Nada que cambiar");
  await env.DB.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, Number(p.id)).run();
  return json({ ok: true });
});

route("DELETE", "/api/accounts/:id", async (_req, env, p) => {
  await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(Number(p.id)).run();
  return json({ ok: true });
});

route("POST", "/api/accounts/:id/test", async (req, env, p) => {
  const { to } = (await req.json()) as { to?: string };
  const dest = cleanEmail(to || "");
  if (!dest) return bad("Dirección de prueba no válida");
  const acc = await loadAccount(env, Number(p.id));
  if (!acc) return bad("No existe", 404);
  const body = `Correo de prueba desde Goteo Mail.\n\nSi lo lees en la bandeja de entrada (y no en spam), el buzón ${acc.email} está listo. Abajo debería verse tu firma.`;
  try {
    const msg = await compose(env, { body, account: acc, campaign: null, unsubscribeUrl: "", mode: "cid" });
    await sendMessage(env, acc, {
      fromName: String(acc.from_name || ""),
      fromEmail: acc.email,
      to: dest,
      subject: "Prueba de Goteo Mail",
      text: msg.text,
      html: msg.html,
      inline: msg.inline,
      messageId: newMessageId(acc.email),
      headers: {},
    });
    await env.DB.prepare("UPDATE accounts SET fail_streak=0, last_error=NULL WHERE id=?").bind(acc.id).run();
    return json({ ok: true });
  } catch (e) {
    return bad(`No se pudo enviar: ${String((e as Error).message || e).slice(0, 300)}`, 502);
  }
});

// --- Contactos
route("POST", "/api/contacts/import", async (req, env) => {
  const b = (await req.json()) as { list?: string; rows?: { email: string; name?: string; fields?: Record<string, string> }[] };
  const list = (b.list || "").trim() || `import-${new Date().toISOString().slice(0, 10)}`;
  const rows = b.rows || [];
  let added = 0,
    updated = 0;
  const invalid: string[] = [];
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const email = cleanEmail(r.email || "");
    if (!email) {
      if ((r.email || "").trim()) invalid.push(String(r.email).slice(0, 80));
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO contacts (email, name, fields, list, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(email) DO UPDATE SET name=CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
           fields=json_patch(contacts.fields, excluded.fields), list=excluded.list`,
      ).bind(email, (r.name || "").trim(), JSON.stringify(r.fields || {}), list, now),
    );
  }
  const existing = new Set<string>();
  const arr = [...seen];
  for (let i = 0; i < arr.length; i += 90) {
    const chunk = arr.slice(i, i + 90);
    const res = await env.DB.prepare(`SELECT email FROM contacts WHERE email IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ email: string }>();
    for (const x of res.results) existing.add(x.email);
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  updated = existing.size;
  added = seen.size - updated;
  await logEvent(env, `Importados ${added} nuevos y ${updated} actualizados en «${list}» (${invalid.length} sin email válido)`);
  return json({ ok: true, list, added, updated, invalid });
});

route("GET", "/api/contacts", async (_req, env, _p, url) => {
  const list = url.searchParams.get("list");
  const q = (url.searchParams.get("q") || "").toLowerCase();
  const where: string[] = [];
  const vals: unknown[] = [];
  if (list) {
    where.push("list = ?");
    vals.push(list);
  }
  if (q) {
    where.push("(email LIKE ? OR lower(name) LIKE ? OR lower(fields) LIKE ?)");
    vals.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const res = await env.DB.prepare(
    `SELECT * FROM contacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 500`,
  )
    .bind(...vals)
    .all();
  return json({ contacts: res.results });
});

route("GET", "/api/contacts/columns", async (_req, env, _p, url) => {
  const list = url.searchParams.get("list");
  const res = await env.DB.prepare(
    `SELECT j.key AS k, j.value AS v, COUNT(*) AS n FROM contacts, json_each(contacts.fields) j
     ${list ? "WHERE contacts.list = ?" : ""} GROUP BY j.key, j.value ORDER BY j.key, n DESC`,
  )
    .bind(...(list ? [list] : []))
    .all<{ k: string; v: string; n: number }>();
  const cols: Record<string, { value: string; n: number }[]> = {};
  for (const r of res.results) (cols[r.k] ||= []).push({ value: String(r.v ?? ""), n: r.n });
  return json({ columns: cols });
});

route("POST", "/api/contacts/:id/mark", async (req, env, p) => {
  const { kind } = (await req.json()) as { kind: "replied" | "bounced" | "unsubscribed" };
  if (!["replied", "bounced", "unsubscribed"].includes(kind)) return bad("Tipo no válido");
  await markContact(env, Number(p.id), kind, Date.now());
  return json({ ok: true });
});

// --- Campañas
route("POST", "/api/campaigns", async (req, env) => {
  const b = (await req.json()) as { name?: string };
  const r = await env.DB.prepare("INSERT INTO campaigns (name, created_at) VALUES (?, ?) RETURNING id")
    .bind((b.name || "Campaña nueva").trim(), Date.now())
    .first<{ id: number }>();
  await env.DB.prepare("INSERT INTO steps (campaign_id, ord, delay_days, subject, body) VALUES (?, 1, 0, '', '')").bind(r!.id).run();
  return json({ id: r!.id });
});

route("GET", "/api/campaigns/:id", async (_req, env, p) => {
  const id = Number(p.id);
  const c = await env.DB.prepare(`SELECT c.*, ${CAMP_STATS} FROM campaigns c WHERE id = ?`).bind(id).first();
  if (!c) return bad("No existe", 404);
  const steps = (await env.DB.prepare("SELECT * FROM steps WHERE campaign_id = ? ORDER BY ord").bind(id).all()).results;
  const perStep = (
    await env.DB.prepare(
      "SELECT s.step, COUNT(*) n FROM sends s JOIN enrollments e ON e.id = s.enrollment_id WHERE e.campaign_id = ? GROUP BY s.step",
    )
      .bind(id)
      .all()
  ).results;
  return json({ campaign: c, steps, perStep });
});

route("PUT", "/api/campaigns/:id", async (req, env, p) => {
  const id = Number(p.id);
  const b = (await req.json()) as {
    name: string;
    account_ids: number[];
    tz: string;
    window_start: number;
    window_end: number;
    days: string;
    track_links: boolean;
    main_link: string;
    button_text?: string;
    button_color?: string;
    header_image_id?: number | null;
    header_width?: number;
    signature_image_id?: number | null;
    signature_width?: number | null;
    steps: { delay_days: number; subject: string; body: string }[];
  };
  const optId = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  const color = /^#[0-9a-f]{6}$/i.test(b.button_color || "") ? b.button_color : "#1d4ed8";
  if (!b.steps?.length) return bad("Hace falta al menos un paso");
  if (!b.steps[0].subject.trim()) return bad("El primer correo necesita asunto");
  const ws = Math.max(0, Math.min(23, Number(b.window_start)));
  const we = Math.max(ws + 1, Math.min(24, Number(b.window_end)));
  try {
    new Intl.DateTimeFormat("en", { timeZone: b.tz });
  } catch {
    return bad("Zona horaria no válida");
  }
  const stmts = [
    env.DB.prepare(
      `UPDATE campaigns SET name=?, account_ids=?, tz=?, window_start=?, window_end=?, days=?, track_links=?, main_link=?,
         button_text=?, button_color=?, header_image_id=?, header_width=?, signature_image_id=?, signature_width=? WHERE id=?`,
    ).bind(
      b.name.trim() || "Campaña",
      JSON.stringify((b.account_ids || []).map(Number)),
      b.tz,
      ws,
      we,
      (b.days || "12345").replace(/[^1-7]/g, "") || "12345",
      b.track_links ? 1 : 0,
      (b.main_link || "").trim(),
      (b.button_text ?? "Solicitar información").slice(0, 40),
      color,
      optId(b.header_image_id),
      Math.max(80, Math.min(640, Number(b.header_width) || 560)),
      optId(b.signature_image_id),
      b.signature_width ? Math.max(80, Math.min(640, Number(b.signature_width))) : null,
      id,
    ),
    env.DB.prepare("DELETE FROM steps WHERE campaign_id = ?").bind(id),
    ...b.steps.map((s, i) =>
      env.DB.prepare("INSERT INTO steps (campaign_id, ord, delay_days, subject, body) VALUES (?,?,?,?,?)").bind(
        id,
        i + 1,
        i === 0 ? 0 : Math.max(1, Number(s.delay_days) || 3),
        s.subject || "",
        s.body || "",
      ),
    ),
  ];
  await env.DB.batch(stmts);
  return json({ ok: true, variants: b.steps.map((s) => spintaxVariants(s.subject) * spintaxVariants(s.body)) });
});

route("DELETE", "/api/campaigns/:id", async (_req, env, p) => {
  await env.DB.prepare("DELETE FROM campaigns WHERE id = ?").bind(Number(p.id)).run();
  return json({ ok: true });
});

interface EnrollFilter {
  list?: string;
  include?: { field: string; values: string[] }[];
  exclude?: { field: string; values: string[] }[];
  skip_contacted_days?: number;
}

function filterSql(f: EnrollFilter): { where: string; vals: unknown[] } {
  const where = ["c.unsubscribed_at IS NULL", "c.bounced_at IS NULL", "c.replied_at IS NULL"];
  const vals: unknown[] = [];
  if (f.list) {
    where.push("c.list = ?");
    vals.push(f.list);
  }
  for (const inc of f.include || []) {
    if (!inc.values?.length) continue;
    where.push(`json_extract(c.fields, ?) IN (${inc.values.map(() => "?").join(",")})`);
    vals.push(`$."${inc.field.replace(/"/g, "")}"`, ...inc.values);
  }
  for (const exc of f.exclude || []) {
    if (!exc.values?.length) continue;
    where.push(`COALESCE(json_extract(c.fields, ?), '') NOT IN (${exc.values.map(() => "?").join(",")})`);
    vals.push(`$."${exc.field.replace(/"/g, "")}"`, ...exc.values);
  }
  if (f.skip_contacted_days) {
    where.push("(c.last_contacted_at IS NULL OR c.last_contacted_at < ?)");
    vals.push(Date.now() - f.skip_contacted_days * 86_400_000);
  }
  return { where: where.join(" AND "), vals };
}

route("POST", "/api/campaigns/:id/enroll", async (req, env, p) => {
  const id = Number(p.id);
  const b = (await req.json()) as EnrollFilter & { dry_run?: boolean };
  const { where, vals } = filterSql(b);
  const cands = (
    await env.DB.prepare(
      `SELECT c.id, c.email FROM contacts c WHERE ${where}
       AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.campaign_id = ? AND e.contact_id = c.id)`,
    )
      .bind(...vals, id)
      .all<{ id: number; email: string }>()
  ).results;
  if (b.dry_run) return json({ count: cands.length, sample: cands.slice(0, 8).map((c) => c.email) });
  // Orden barajado: que el goteo no vaya alfabético ni por empresa (varios de
  // la misma empresa seguidos es una señal clara de envío masivo).
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cands[i], cands[j]] = [cands[j], cands[i]];
  }
  const now = Date.now();
  const stmts = cands.map((c, i) =>
    env.DB.prepare("INSERT OR IGNORE INTO enrollments (campaign_id, contact_id, token, due_at) VALUES (?,?,?,?)").bind(
      id,
      c.id,
      randomToken(12),
      now + i, // conserva el orden barajado
    ),
  );
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await logEvent(env, `${cands.length} contactos añadidos a la campaña`, { campaign_id: id });
  return json({ added: cands.length });
});

route("POST", "/api/campaigns/:id/status", async (req, env, p) => {
  const id = Number(p.id);
  const { status } = (await req.json()) as { status: string };
  if (!["active", "paused", "draft"].includes(status)) return bad("Estado no válido");
  if (status === "active") {
    const c = await env.DB.prepare("SELECT account_ids FROM campaigns WHERE id = ?").bind(id).first<{ account_ids: string }>();
    if (!c || JSON.parse(c.account_ids).length === 0) return bad("Elige al menos un buzón antes de activar");
    const s = await env.DB.prepare("SELECT subject, body FROM steps WHERE campaign_id = ? AND ord = 1").bind(id).first<{ subject: string; body: string }>();
    if (!s?.subject.trim() || !s.body.trim()) return bad("El primer correo necesita asunto y texto");
  }
  await env.DB.prepare("UPDATE campaigns SET status = ?, stopped_reason = CASE WHEN ? = 'active' THEN NULL ELSE stopped_reason END WHERE id = ?")
    .bind(status, status, id)
    .run();
  await logEvent(env, `Campaña ${status === "active" ? "activada" : status === "paused" ? "pausada" : "a borrador"}`, { campaign_id: id });
  return json({ ok: true });
});

route("GET", "/api/campaigns/:id/recipients", async (_req, env, p, url) => {
  const status = url.searchParams.get("status");
  const res = await env.DB.prepare(
    `SELECT e.id, e.status, e.next_step, e.due_at, e.attempts, e.last_error, c.id AS contact_id, c.email, c.name,
       a.email AS account_email,
       (SELECT MAX(sent_at) FROM sends s WHERE s.enrollment_id = e.id) AS last_sent,
       (SELECT COALESCE(SUM(clicks),0) FROM links l WHERE l.enrollment_id = e.id) AS clicks
     FROM enrollments e JOIN contacts c ON c.id = e.contact_id LEFT JOIN accounts a ON a.id = e.account_id
     WHERE e.campaign_id = ? ${status ? "AND e.status = ?" : ""}
     ORDER BY last_sent DESC NULLS LAST, e.due_at ASC LIMIT 1000`,
  )
    .bind(Number(p.id), ...(status ? [status] : []))
    .all();
  return json({ recipients: res.results });
});

route("POST", "/api/campaigns/:id/enrollments/:eid/retry", async (_req, env, p) => {
  await env.DB.prepare("UPDATE enrollments SET status='pending', attempts=0, last_error=NULL WHERE id=? AND campaign_id=?")
    .bind(Number(p.eid), Number(p.id))
    .run();
  return json({ ok: true });
});

route("POST", "/api/campaigns/:id/preview", async (req, env, p) => {
  const b = (await req.json()) as {
    step: { subject: string; body: string };
    ord: number;
    contact_id?: number;
    main_link?: string;
    account_id?: number;
    design?: ComposeCampaign;
  };
  const contact = b.contact_id
    ? await env.DB.prepare("SELECT * FROM contacts WHERE id = ?").bind(b.contact_id).first<Record<string, string>>()
    : await env.DB.prepare(
        "SELECT c.* FROM enrollments e JOIN contacts c ON c.id = e.contact_id WHERE e.campaign_id = ? ORDER BY e.due_at LIMIT 1",
      )
        .bind(Number(p.id))
        .first<Record<string, string>>();
  const acc = b.account_id
    ? await env.DB.prepare("SELECT from_name, signature, signature_image_id, signature_width FROM accounts WHERE id = ?")
        .bind(b.account_id)
        .first<Record<string, unknown>>()
    : null;
  const ct = contact
    ? { email: contact.email, name: contact.name, fields: JSON.parse(contact.fields || "{}") }
    : { email: "ejemplo@dominio.com", name: "Nombre Ejemplo", fields: {} };
  const subj = b.ord > 1 && !b.step.subject.trim() ? "Re: (asunto del primer correo)" : b.step.subject;
  const r = render(subj, b.step.body, { contact: ct, senderName: String(acc?.from_name || ""), enlace: b.main_link || "" }, `${ct.email}:${p.id}:${b.ord}`);
  const msg = await compose(env, {
    body: r.body,
    account: acc,
    campaign: b.design || null,
    unsubscribeUrl: `${env.PUBLIC_URL}/u/ejemplo`,
    mode: "url",
  });
  return json({
    to: ct.email,
    subject: r.subject,
    text: msg.text,
    html: msg.html,
    missing: r.missing,
    variants: spintaxVariants(b.step.subject) * spintaxVariants(b.step.body),
  });
});

route("POST", "/api/tick", async (_req, env) => json(await runTick(env)));

// --- Imágenes (firmas, cabeceras, fotos)
route("GET", "/api/images", async (_req, env) => {
  const res = await env.DB.prepare("SELECT id, name, mime, bytes, created_at FROM images ORDER BY id DESC").all();
  return json({ images: res.results });
});

route("POST", "/api/images", async (req, env) => {
  const b = (await req.json()) as { name?: string; data_uri?: string };
  const m = (b.data_uri || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) return bad("Imagen no válida");
  const mime = m[1].toLowerCase();
  if (!IMG_TYPES.includes(mime)) return bad("Usa PNG, JPG o GIF (Outlook no muestra WebP)");
  const bytes = Math.floor((m[2].length * 3) / 4) - (m[2].endsWith("==") ? 2 : m[2].endsWith("=") ? 1 : 0);
  if (bytes > IMG_MAX_BYTES) {
    return bad(`La imagen pesa ${Math.round(bytes / 1024)} KB; el máximo es 400 KB. Redúcela (una firma ronda 50-150 KB): los correos pesados puntúan peor en los filtros.`);
  }
  const r = await env.DB.prepare("INSERT INTO images (name, mime, data_b64, bytes, created_at) VALUES (?,?,?,?,?) RETURNING id")
    .bind((b.name || "imagen").slice(0, 120), mime, m[2], bytes, Date.now())
    .first<{ id: number }>();
  return json({ id: r!.id });
});

route("DELETE", "/api/images/:id", async (_req, env, p) => {
  const id = Number(p.id);
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET signature_image_id = NULL WHERE signature_image_id = ?").bind(id),
    env.DB.prepare("UPDATE campaigns SET header_image_id = NULL WHERE header_image_id = ?").bind(id),
    env.DB.prepare("UPDATE campaigns SET signature_image_id = NULL WHERE signature_image_id = ?").bind(id),
    env.DB.prepare("DELETE FROM images WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
});

// ---------- Router ----------
function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = path.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    let p: Record<string, string> | null;

    if ((p = match("/l/:code", path))) return trackLink(req, env, p, url);
    if ((p = match("/u/:token", path))) return unsubPage(req, env, p, url);
    if ((p = match("/img/:id", path))) {
      const img = await env.DB.prepare("SELECT mime, data_b64 FROM images WHERE id = ?").bind(Number(p.id)).first<{ mime: string; data_b64: string }>();
      if (!img) return new Response("No encontrada", { status: 404 });
      const bin = Uint8Array.from(atob(img.data_b64), (c) => c.charCodeAt(0));
      return new Response(bin, { headers: { "content-type": img.mime, "cache-control": "public, max-age=86400" } });
    }
    if ((p = match("/oauth/:provider/callback", path)) && ["google", "microsoft"].includes(p.provider)) {
      return oauthCallback(req, env, p, url);
    }

    const admin = await isAdmin(req, env);
    if ((p = match("/oauth/:provider/start", path)) && ["google", "microsoft"].includes(p.provider)) {
      if (!admin) return Response.redirect(`${url.origin}/`, 302);
      return oauthStart(req, env, p, url);
    }

    if (path.startsWith("/api/")) {
      if (path !== "/api/login" && !admin) return bad("Sesión caducada", 401);
      // CSRF: las escrituras solo desde el propio panel
      if (req.method !== "GET" && req.headers.get("x-goteo") !== "1") return bad("Petición no permitida", 403);
      for (const [key, h] of Object.entries(api)) {
        const [m, pat] = key.split(" ");
        if (m !== req.method) continue;
        const params = match(pat, path);
        if (params) {
          try {
            return await h(req, env, params, url);
          } catch (e) {
            return bad(`Error: ${String((e as Error).message || e)}`, 500);
          }
        }
      }
      return bad("No encontrado", 404);
    }
    return env.ASSETS.fetch(req);
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runTick(env));
  },
} satisfies ExportedHandler<Env>;
