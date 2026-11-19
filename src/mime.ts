// Construcción del mensaje MIME (para Gmail API y Microsoft Graph). El envío
// por SMTP usa worker-mailer con las mismas cabeceras.

function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64url(s: string): string {
  return b64utf8(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function wrap76(s: string): string {
  return s.replace(/(.{76})/g, "$1\r\n");
}

export function encodeHeaderWord(s: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64utf8(s)}?=`;
}

export function formatAddress(name: string, email: string): string {
  if (!name) return email;
  const safe = name.replace(/["\\]/g, "");
  const word = encodeHeaderWord(safe);
  return `${word === safe ? `"${safe}"` : word} <${email}>`;
}

export function newMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] || "localhost";
  const rnd = crypto.getRandomValues(new Uint8Array(12));
  const id = [...rnd].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `<${Date.now().toString(36)}.${id}@${domain}>`;
}

export interface OutMessage {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  headers: Record<string, string>; // List-Unsubscribe, In-Reply-To, References…
}

export function buildMime(m: OutMessage): string {
  const boundary = `b_${crypto.randomUUID().replace(/-/g, "")}`;
  const head: string[] = [
    `From: ${formatAddress(m.fromName, m.fromEmail)}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeaderWord(m.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${m.messageId}`,
    "MIME-Version: 1.0",
  ];
  for (const [k, v] of Object.entries(m.headers)) head.push(`${k}: ${v}`);
  head.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return [
    head.join("\r\n"),
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64utf8(m.text)),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64utf8(m.html)),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
