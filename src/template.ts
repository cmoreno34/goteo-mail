// Plantillas: spintax determinista + huecos + reescritura de enlaces.
// Lógica pura (sin Cloudflare) para poder probarla con `node --test`.

// ---------- Spintax ----------
// {Hola|Buenas|Qué tal} → una opción por destinatario, SIEMPRE la misma para
// el mismo contacto (semilla), así la vista previa es exactamente lo que sale.
// {nombre} (sin barra) no es spintax y se respeta para los huecos.

const GROUP = /\{([^{}]+)\}/g;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function expandSpintax(text: string, seed: string): string {
  if (!text || !text.includes("{")) return text || "";
  return text.replace(GROUP, (whole, inner: string) => {
    if (!inner.includes("|")) return whole;
    const opts = inner.split("|").map((o) => o.trim());
    return opts[fnv1a(`${seed}|${inner}`) % opts.length];
  });
}

export function spintaxVariants(text: string): number {
  let total = 1;
  for (const m of (text || "").matchAll(GROUP)) {
    if (m[1].includes("|")) total *= m[1].split("|").length;
  }
  return total;
}

// ---------- Huecos ----------
export function normKey(k: string): string {
  return k
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function firstName(full: string): string {
  const parts = (full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const p = parts[0];
  // «LAURA» → «Laura»; «laura» → «Laura»; respeta «María José» en la primera palabra
  if (p === p.toUpperCase() || p === p.toLowerCase()) {
    return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  }
  return p;
}

export interface TemplateContact {
  email: string;
  name: string;
  fields: Record<string, string>;
}

export interface TemplateCtx {
  contact: TemplateContact;
  senderName: string;
  enlace: string;
}

export function placeholderValues(ctx: TemplateCtx): Map<string, string> {
  const v = new Map<string, string>();
  // Primero las columnas del CSV (cualquier columna vale como hueco)…
  for (const [k, val] of Object.entries(ctx.contact.fields || {})) {
    v.set(normKey(k), String(val ?? "").trim());
  }
  // …y encima los fijos, que mandan.
  const full = (ctx.contact.name || "").trim();
  v.set("nombre_completo", full);
  v.set("nombre", firstName(full));
  v.set("email", ctx.contact.email);
  v.set("remitente", ctx.senderName);
  v.set("yo", ctx.senderName);
  v.set("enlace", ctx.enlace);
  return v;
}

const HUECO = /\{([^{}|]+)\}/g;

export function fillPlaceholders(text: string, values: Map<string, string>): string {
  return text.replace(HUECO, (whole, key: string) => {
    const k = normKey(key);
    return values.has(k) ? (values.get(k) as string) : whole;
  });
}

/** Huecos que quedan sin rellenar (o rellenados en vacío) → no se envía. */
export function missingPlaceholders(
  template: string,
  values: Map<string, string>,
): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(HUECO)) {
    const k = normKey(m[1]);
    if (!values.has(k) || !values.get(k)) out.add(m[1]);
  }
  return [...out].sort();
}

export function render(
  subject: string,
  body: string,
  ctx: TemplateCtx,
  seed: string,
): { subject: string; body: string; missing: string[] } {
  const values = placeholderValues(ctx);
  const s1 = expandSpintax(subject, `${seed}:subject`);
  const b1 = expandSpintax(body, `${seed}:body`);
  const missing = [...new Set([...missingPlaceholders(s1, values), ...missingPlaceholders(b1, values)])].sort();
  return {
    subject: fillPlaceholders(s1, values).replace(/\s*\n\s*/g, " ").trim(),
    body: fillPlaceholders(b1, values),
    missing,
  };
}

// ---------- Validación de direcciones ----------
// Lección del CRM: una dirección que el SMTP no puede mandar (tildes, «mailto:»
// pegado, placeholders de Cloudflare) NO es un fallo de envío, es un dato malo.
// Se aparta antes de tocar el buzón para que no tapone la cola.
export const EMAIL_OK =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export function cleanEmail(raw: string): string | null {
  let e = (raw || "").trim().replace(/^mailto:/i, "").replace(/[<>"']/g, "").toLowerCase();
  // Notion a veces exporta «Nombre <x@y.com>» o varias separadas por coma
  e = e.split(/[,;\s]+/).find((p) => p.includes("@")) || "";
  if (!EMAIL_OK.test(e)) return null;
  if (/example\.(com|org)$|email-protected|protected\]/.test(e)) return null;
  return e;
}

// ---------- Enlaces ----------
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

export function findUrls(text: string): string[] {
  return [...new Set(text.match(URL_RE) || [])];
}

export function replaceUrls(text: string, map: Map<string, string>): string {
  return text.replace(URL_RE, (u) => map.get(u) ?? u);
}

// ---------- Texto → HTML sencillo ----------
// Correo de persona: sin imágenes, sin plantillas pesadas. El HTML solo da
// párrafos y enlaces con nombre (la URL larga en medio del texto parece estafa).
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function textToHtml(text: string, unsubscribeUrl: string): string {
  const linked = escapeHtml(text).replace(URL_RE, (u) => {
    const raw = u.replace(/&amp;/g, "&");
    return `<a href="${raw.replace(/"/g, "%22")}">${u}</a>`;
  });
  const paras = linked
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  const baja = unsubscribeUrl
    ? `<p style="margin:24px 0 0;font-size:11px;color:#888">Si no desea recibir más correos, <a href="${unsubscribeUrl}" style="color:#888">dese de baja aquí</a>.</p>`
    : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${paras}${baja}</div>`;
}

export function textWithUnsub(text: string, unsubscribeUrl: string): string {
  return unsubscribeUrl
    ? `${text}\n\n—\nSi no desea recibir más correos, dese de baja aquí: ${unsubscribeUrl}`
    : text;
}
