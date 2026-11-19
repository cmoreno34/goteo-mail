// Texto del editor → correo HTML, como el CRM (mail_html.py):
//   **negrita**            → <strong>
//   [azul]texto[/azul]     → color (rojo, azul, verde, naranja, morado, gris)
//   [texto](https://…)     → ese texto enlazado a esa URL exacta
//   [imagen:12]            → foto subida, incrustada
//   la PRIMERA URL suelta (normalmente {enlace}) → BOTÓN («Solicitar información»);
//   si se repite, cada repetición es también el botón.
// Corchetes y no llaves: las llaves son de los huecos {nombre} y las variantes {a|b}.
// Lógica pura, probada con `node --test`.

export const COLORS: Record<string, string> = {
  rojo: "#b91c1c",
  azul: "#1d4ed8",
  verde: "#15803d",
  naranja: "#c2410c",
  morado: "#6d28d9",
  gris: "#4b5563",
};
const CNAMES = Object.keys(COLORS).join("|");
const RE_COLOR = new RegExp(`\\[(${CNAMES})\\]([\\s\\S]*?)\\[\\/\\1\\]`, "g");
const RE_COLOR_LOOSE = new RegExp(`\\[\\/?(?:${CNAMES})\\]`, "g");
const RE_BOLD = /\*\*([^*\n]+)\*\*/g;
const RE_MDLINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const RE_IMG = /\[imagen:(\d+)\]/g;
const RE_URL = /https?:\/\/[^\s<>"')\]]+/g;
const LINK_STYLE = "color:#1d4ed8;text-decoration:underline;";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function splitTrailingPunct(url: string): [string, string] {
  const m = url.match(/[.,;:!?]+$/);
  return m ? [url.slice(0, -m[0].length), m[0]] : [url, ""];
}

/** La URL del botón: la primera URL suelta, saltando las de [texto](url). */
export function buttonUrl(text: string): string | null {
  for (const m of text.matchAll(RE_URL)) {
    const i = m.index ?? 0;
    if (text.slice(Math.max(0, i - 2), i) === "](") continue;
    return splitTrailingPunct(m[0])[0];
  }
  return null;
}

/** IDs de las fotos usadas con [imagen:N]. */
export function imageRefs(text: string): number[] {
  return [...new Set([...text.matchAll(RE_IMG)].map((m) => Number(m[1])))];
}

/** Quita el color/negrita que envuelva al botón (no puede aplicarse a un botón). */
function cleanAroundButton(text: string, url: string): string {
  let out = text.replace(RE_COLOR, (whole, _c, inner: string) => (inner.includes(url) ? inner : whole));
  out = out.replace(RE_BOLD, (whole, inner: string) => (inner.includes(url) ? inner : whole));
  return out;
}

function inline(escaped: string, imgCid: (id: number) => string | null): string {
  let s = escaped.replace(RE_COLOR, (_w, c: string, inner: string) => `<span style="color:${COLORS[c]};">${inner}</span>`);
  s = s.replace(RE_COLOR_LOOSE, "");
  s = s.replace(RE_BOLD, "<strong>$1</strong>");
  s = s.replace(RE_IMG, (_w, id: string) => {
    const cid = imgCid(Number(id));
    return cid
      ? `<img src="${cid}" alt="" style="max-width:100%;height:auto;border:0;display:block;margin:8px 0;">`
      : "";
  });
  // Enlaces con texto y luego URLs sueltas (que no estén ya dentro de un href)
  const holders: string[] = [];
  s = s.replace(RE_MDLINK, (_w, label: string, url: string) => {
    holders.push(`<a href="${url}" style="${LINK_STYLE}">${label}</a>`);
    return `\u0000${holders.length - 1}\u0000`;
  });
  s = s.replace(RE_URL, (u) => {
    const [url, tail] = splitTrailingPunct(u);
    return `<a href="${url}" style="${LINK_STYLE}">${url}</a>${tail}`;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_w, i: string) => holders[Number(i)]);
}

function paragraphs(text: string, imgCid: (id: number) => string | null): string {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return "";
  return t
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;">${inline(esc(p).replace(/\n/g, "<br>"), imgCid)}</p>`)
    .join("");
}

export function buttonHtml(url: string, label: string, color: string): string {
  // Botón «a prueba de balas»: el <td bgcolor> hace que Outlook de escritorio
  // (motor de Word) siga viendo un botón; align=center porque ignora margin:auto.
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:18px auto;">` +
    `<tr><td bgcolor="${esc(color)}" style="border-radius:6px;">` +
    `<a href="${esc(url)}" style="display:inline-block;padding:12px 26px;font-family:Arial,Helvetica,sans-serif;` +
    `font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">${esc(label)}</a>` +
    `</td></tr></table>`
  );
}

export interface HtmlOpts {
  buttonText: string;
  buttonColor: string;
  imgSrc: (id: number) => string | null; // [imagen:N] → "cid:…" o URL (null si no existe)
  header?: { src: string; width: number } | null;
  signature?: { src: string; width: number } | null;
  signatureText?: string;
  unsubscribeUrl?: string;
}

export function buildHtml(body: string, o: HtmlOpts): string {
  const raw = body.replace(/\r\n/g, "\n");
  const url = buttonUrl(raw);
  let content: string;
  if (url && o.buttonText.trim()) {
    const cleaned = cleanAroundButton(raw, url);
    const parts = cleaned.split(url).map((p, i, arr) => {
      // El «.» que cerraba la frase del enlace se queda solo: fuera.
      if (i > 0 && !p.replace(/[.,;:!?\s]/g, "") && i === arr.length - 1) return "";
      return i > 0 ? p.replace(/^[.,;:!?]+/, "") : p;
    });
    const btn = buttonHtml(url, o.buttonText, o.buttonColor || COLORS.azul);
    content = parts.map((p) => paragraphs(p, o.imgSrc)).join(btn);
  } else {
    content = paragraphs(raw, o.imgSrc);
  }

  const header = o.header
    ? `<div style="text-align:center;margin:0 0 18px;"><img src="${o.header.src}" alt="" width="${o.header.width}" style="width:${o.header.width}px;max-width:100%;height:auto;border:0;display:block;margin:0 auto;"></div>`
    : "";
  const sigText = o.signatureText?.trim() ? `<div style="margin-top:18px;">${paragraphs(o.signatureText, o.imgSrc)}</div>` : "";
  const sigImg = o.signature
    ? `<div style="margin-top:18px;"><img src="${o.signature.src}" alt="" width="${o.signature.width}" style="width:${o.signature.width}px;max-width:100%;height:auto;border:0;display:block;"></div>`
    : "";
  // La baja: pequeña y gris, pero visible (un enlace escondido es justo lo que buscan los filtros).
  const unsub = o.unsubscribeUrl
    ? `<div style="margin-top:18px;padding-top:10px;border-top:1px solid #e5e7eb;font-size:11px;line-height:1.5;color:#9ca3af;">Si no desea recibir más información, <a href="${esc(o.unsubscribeUrl)}" style="color:#9ca3af;text-decoration:underline;">dese de baja aquí</a>.</div>`
    : "";
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f2937;max-width:640px;">` +
    header + content + sigText + sigImg + unsub + `</div>`
  );
}

/** Versión de texto plano: sin marcado; el botón pasa a «Etiqueta: URL». */
export function buildText(body: string, o: { buttonText: string; signatureText?: string; unsubscribeUrl?: string }): string {
  let t = body.replace(/\r\n/g, "\n");
  const url = buttonUrl(t);
  t = t.replace(RE_COLOR, "$2").replace(RE_COLOR_LOOSE, "").replace(RE_BOLD, "$1");
  t = t.replace(RE_MDLINK, "$1 ($2)").replace(RE_IMG, "");
  if (url && o.buttonText.trim()) {
    t = t.split(url).join(`${o.buttonText}: ${url}`);
  }
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  if (o.signatureText?.trim()) t += `\n\n${o.signatureText.trim()}`;
  if (o.unsubscribeUrl) t += `\n\n—\nSi no desea recibir más información, dese de baja aquí: ${o.unsubscribeUrl}`;
  return t;
}
