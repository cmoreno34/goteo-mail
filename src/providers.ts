// Envío y lectura de respuestas por proveedor:
//  · smtp       → cualquier SMTP (Gmail con contraseña de aplicación, dominio propio…)
//  · google     → Gmail API con OAuth (envía y detecta respuestas/rebotes)
//  · microsoft  → Microsoft Graph con OAuth (Outlook.com y Microsoft 365)
import { Email, WorkerMailer } from "worker-mailer";
import { buildMime, b64url, type OutMessage } from "./mime.ts";

// worker-mailer monta su propio MIME y no sabe de imágenes incrustadas (cid:).
// Para que el SMTP mande EXACTAMENTE el mismo mensaje que Gmail API y Graph,
// se le pasa el MIME ya construido: su getEmailData devuelve el nuestro cuando
// el correo lleva la marca X-Goteo-Raw (la marca no llega a salir).
const RAW = new Map<string, string>();
const proto = Email.prototype as unknown as {
  __goteo?: boolean;
  getEmailData: () => string;
  applyDotStuffing: (s: string) => string;
  headers: Record<string, string>;
};
if (!proto.__goteo) {
  const orig = proto.getEmailData;
  proto.getEmailData = function (this: typeof proto) {
    const id = this.headers?.["X-Goteo-Raw"];
    const raw = id ? RAW.get(id) : undefined;
    return raw ? `${this.applyDotStuffing(raw)}\r\n.\r\n` : orig.call(this);
  };
  proto.__goteo = true;
}
import type { Env } from "./env.ts";

export interface AccountRow {
  id: number;
  provider: "smtp" | "google" | "microsoft";
  email: string;
  from_name: string;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  secret: string; // descifrado
}

export interface SendResult {
  messageId: string;
  threadId?: string;
}

// ---------- OAuth ----------
const tokenCache = new Map<number, { token: string; exp: number }>();

export function oauthConfig(env: Env, provider: "google" | "microsoft") {
  if (provider === "google") {
    return {
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      scope: "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly",
      extra: { access_type: "offline", prompt: "consent" } as Record<string, string>,
    };
  }
  return {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
    scope: "openid email offline_access User.Read Mail.Send Mail.Read",
    extra: { prompt: "select_account" } as Record<string, string>,
  };
}

async function accessToken(env: Env, acc: AccountRow): Promise<string> {
  const c = tokenCache.get(acc.id);
  if (c && c.exp > Date.now() + 60_000) return c.token;
  const cfg = oauthConfig(env, acc.provider as "google" | "microsoft");
  const r = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: acc.secret,
      grant_type: "refresh_token",
      ...(acc.provider === "microsoft" ? { scope: cfg.scope } : {}),
    }),
  });
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`token ${r.status} ${j.error || ""} ${j.error_description || ""}`);
  tokenCache.set(acc.id, { token: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 });
  return j.access_token;
}

// ---------- Envío ----------
export async function sendMessage(
  env: Env,
  acc: AccountRow,
  m: OutMessage,
  threadId?: string | null,
): Promise<SendResult> {
  if (env.DRY_RUN === "1") {
    console.log(`[DRY_RUN] ${acc.email} → ${m.to} | ${m.subject}\n${m.text}\n`);
    if (/fallo-simulado/.test(m.to)) throw new Error("550 5.1.1 Recipient address rejected: user unknown");
    return { messageId: m.messageId, threadId: threadId || `dry-${m.messageId}` };
  }
  if (acc.provider === "smtp") {
    const port = acc.smtp_port || 465;
    const rawId = crypto.randomUUID();
    RAW.set(rawId, buildMime(m));
    try {
    await WorkerMailer.send(
      {
        host: acc.smtp_host || "smtp.gmail.com",
        port,
        secure: port === 465,
        startTls: port !== 465,
        credentials: { username: acc.smtp_user || acc.email, password: acc.secret },
        authType: ["plain", "login"],
        socketTimeoutMs: 30_000,
        responseTimeoutMs: 30_000,
      },
      {
        from: { name: m.fromName, email: m.fromEmail },
        to: m.to,
        subject: m.subject,
        text: m.text,
        html: m.html,
        headers: { "X-Goteo-Raw": rawId },
      },
    );
    } finally {
      RAW.delete(rawId);
    }
    return { messageId: m.messageId };
  }

  const token = await accessToken(env, acc);
  const mime = buildMime(m);

  if (acc.provider === "google") {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: b64url(mime), ...(threadId ? { threadId } : {}) }),
    });
    const j = (await r.json()) as { id?: string; threadId?: string; error?: { message?: string } };
    if (!r.ok) throw new Error(`gmail ${r.status} ${j.error?.message || ""}`);
    return { messageId: m.messageId, threadId: j.threadId };
  }

  // Microsoft Graph acepta el MIME tal cual (en base64) → conserva
  // List-Unsubscribe e In-Reply-To, que por JSON no deja poner.
  const bytes = new TextEncoder().encode(mime);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const r = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
    body: btoa(bin),
  });
  if (!r.ok) throw new Error(`graph ${r.status} ${(await r.text()).slice(0, 300)}`);
  return { messageId: m.messageId };
}

// ---------- Respuestas y rebotes ----------
export interface InboxHit {
  from: string;
  snippet: string;
  at: number;
}

const BOUNCE_FROM = /mailer-daemon|postmaster|microsoftexchange|mail delivery/i;

export function isBounceSender(from: string): boolean {
  return BOUNCE_FROM.test(from);
}

function addrOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

/**
 * Mensajes recibidos desde `sinceMs` que vienen de alguno de `emails` o de un
 * servidor de rebotes. Limitado (`maxFetch`) por el tope de subpeticiones de
 * Workers. Solo para google/microsoft; SMTP no tiene bandeja que leer.
 */
export async function inboxSince(
  env: Env,
  acc: AccountRow,
  sinceMs: number,
  emails: string[],
  maxFetch = 25,
): Promise<InboxHit[]> {
  if (acc.provider === "smtp") return [];
  const token = await accessToken(env, acc);
  const hits: InboxHit[] = [];

  if (acc.provider === "google") {
    const after = Math.floor(sinceMs / 1000);
    const who = emails.slice(0, 40).map((e) => `from:${e}`);
    const q = `after:${after} {${[...who, "from:mailer-daemon", "from:postmaster"].join(" ")}}`;
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxFetch}&q=${encodeURIComponent(q)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const j = (await r.json()) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!r.ok) throw new Error(`gmail ${r.status} ${j.error?.message || ""}`);
    for (const msg of (j.messages || []).slice(0, maxFetch)) {
      const d = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!d.ok) continue;
      const dj = (await d.json()) as { snippet?: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } };
      const from = dj.payload?.headers?.find((h) => h.name.toLowerCase() === "from")?.value || "";
      hits.push({ from: addrOf(from) || from, snippet: dj.snippet || "", at: Number(dj.internalDate || 0) });
    }
    return hits;
  }

  const iso = new Date(sinceMs).toISOString();
  const url =
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=${Math.min(50, maxFetch * 2)}` +
    `&$select=from,bodyPreview,receivedDateTime&$orderby=receivedDateTime desc` +
    `&$filter=${encodeURIComponent(`receivedDateTime ge ${iso}`)}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const j = (await r.json()) as {
    value?: { from?: { emailAddress?: { address?: string; name?: string } }; bodyPreview?: string; receivedDateTime?: string }[];
    error?: { message?: string };
  };
  if (!r.ok) throw new Error(`graph ${r.status} ${j.error?.message || ""}`);
  const wanted = new Set(emails);
  for (const v of j.value || []) {
    const addr = (v.from?.emailAddress?.address || "").toLowerCase();
    const name = v.from?.emailAddress?.name || "";
    if (wanted.has(addr) || isBounceSender(addr) || isBounceSender(name)) {
      hits.push({ from: addr || name, snippet: v.bodyPreview || "", at: Date.parse(v.receivedDateTime || "") || 0 });
    }
  }
  return hits;
}

/** Email del usuario recién conectado por OAuth. */
export async function whoAmI(provider: "google" | "microsoft", token: string): Promise<string> {
  if (provider === "google") {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${token}` } });
    const j = (await r.json()) as { emailAddress?: string };
    return (j.emailAddress || "").toLowerCase();
  }
  const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers: { authorization: `Bearer ${token}` } });
  const j = (await r.json()) as { mail?: string; userPrincipalName?: string };
  return (j.mail || j.userPrincipalName || "").toLowerCase();
}
