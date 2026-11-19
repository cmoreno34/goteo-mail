// Cifrado de secretos de buzón (AES-GCM) y firma de sesión (HMAC).

const enc = new TextEncoder();

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toB64(buf: Uint8Array): string {
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function encrypt(plain: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plain)));
  return `${toB64(iv)}.${toB64(ct)}`;
}

export async function decrypt(blob: string, secret: string): Promise<string> {
  const [iv, ct] = blob.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await aesKey(secret), fromB64(ct));
  return new TextDecoder().decode(pt);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(data: string, secret: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data)));
  return toB64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function verify(data: string, sig: string, secret: string): Promise<boolean> {
  const expected = await sign(data, secret);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return toB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
