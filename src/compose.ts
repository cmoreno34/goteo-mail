// Monta el correo final (texto + HTML + imágenes incrustadas) a partir del
// cuerpo ya rellenado. Lo usan el goteo, el envío de prueba y la vista previa,
// para que los tres produzcan exactamente el mismo correo.
import type { Env } from "./env.ts";
import { buildHtml, buildText, imageRefs } from "./html.ts";
import type { InlineImage } from "./mime.ts";

export interface ComposeAccount {
  signature?: unknown;
  signature_image_id?: unknown;
  signature_width?: unknown;
}

export interface ComposeCampaign {
  button_text?: string | null;
  button_color?: string | null;
  header_image_id?: number | null;
  header_width?: number | null;
  signature_image_id?: number | null; // 0 = sin firma de imagen; null = la del buzón
  signature_width?: number | null;
}

interface ImgRow {
  id: number;
  name: string;
  mime: string;
  data_b64: string;
}

export async function compose(
  env: Env,
  o: {
    body: string;
    account: ComposeAccount | Record<string, unknown> | null;
    campaign: ComposeCampaign | null;
    unsubscribeUrl: string;
    /** "cid" para enviar; "url" para la vista previa en el panel */
    mode: "cid" | "url";
  },
): Promise<{ text: string; html: string; inline: InlineImage[] }> {
  const c = o.campaign || {};
  const a = (o.account || {}) as ComposeAccount;
  const sigId = c.signature_image_id === 0 ? null : (c.signature_image_id ?? (a.signature_image_id as number | null) ?? null);
  const sigWidth = Number(c.signature_image_id ? c.signature_width : a.signature_width) || 420;
  const ids = [...new Set([...imageRefs(o.body), ...(c.header_image_id ? [c.header_image_id] : []), ...(sigId ? [sigId] : [])])];

  const imgs = new Map<number, ImgRow>();
  if (ids.length) {
    const rows = await env.DB.prepare(`SELECT id, name, mime, data_b64 FROM images WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<ImgRow>();
    for (const r of rows.results) imgs.set(r.id, r);
  }
  const used = new Set<number>();
  const src = (id: number | null | undefined): string | null => {
    if (!id || !imgs.has(id)) return null;
    used.add(id);
    return o.mode === "cid" ? `cid:img${id}@goteo` : `/img/${id}`;
  };

  const buttonText = c.button_text ?? "Solicitar información";
  const signatureText = String(a.signature || "");
  const header = c.header_image_id && src(c.header_image_id) ? { src: src(c.header_image_id)!, width: Number(c.header_width) || 560 } : null;
  const signature = sigId && src(sigId) ? { src: src(sigId)!, width: sigWidth } : null;

  const html = buildHtml(o.body, {
    buttonText,
    buttonColor: c.button_color || "#1d4ed8",
    imgSrc: src,
    header,
    signature,
    signatureText,
    unsubscribeUrl: o.unsubscribeUrl,
  });
  const text = buildText(o.body, { buttonText, signatureText, unsubscribeUrl: o.unsubscribeUrl });
  const inline: InlineImage[] = o.mode === "cid"
    ? [...used].map((id) => {
        const r = imgs.get(id)!;
        return { cid: `img${id}@goteo`, mime: r.mime, b64: r.data_b64, name: r.name || `imagen${id}` };
      })
    : [];
  return { text, html, inline };
}
