// Servidor de pruebas SIN wrangler/workerd (p. ej. si Windows bloquea workerd.exe).
// Imita D1 con node:sqlite y sirve /public. Envíos siempre simulados (DRY_RUN=1).
//
//   node scripts/dev-node.mjs            → http://localhost:8787  (contraseña: local-dev)
//
// Base de datos en .wrangler/dev-node.sqlite (bórrala para empezar de cero).
import { register } from "node:module";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// worker-mailer usa `cloudflare:sockets`, que no existe en Node → se sustituye.
register(
  "data:text/javascript," +
    encodeURIComponent(`
    export async function resolve(spec, ctx, next) {
      if (spec === "cloudflare:sockets" || spec === "worker-mailer") return { url: "data:text/javascript,export class WorkerMailer{static async send(){throw new Error('SMTP real no disponible en Node: usa DRY_RUN')}}", shortCircuit: true };
      return next(spec, ctx);
    }`),
);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, ".wrangler"), { recursive: true });
const dbPath = join(root, ".wrangler", "dev-node.sqlite");
const fresh = !existsSync(dbPath);
const sqlite = new DatabaseSync(dbPath);
if (fresh) {
  for (const f of readdirSync(join(root, "migrations")).sort()) sqlite.exec(readFileSync(join(root, "migrations", f), "utf8"));
}

class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a.map((x) => (typeof x === "boolean" ? Number(x) : x === undefined ? null : x))); }
  async first() { const r = sqlite.prepare(this.sql).get(...this.args); return r ? { ...r } : null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  async run() { const r = sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
  _run() { return sqlite.prepare(this.sql).run(...this.args); }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  async batch(stmts) {
    sqlite.exec("BEGIN");
    try { const out = stmts.map((s) => s._run()); sqlite.exec("COMMIT"); return out; }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  },
};

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".csv": "text/csv" };
const ASSETS = {
  async fetch(req) {
    const p = new URL(req.url).pathname;
    // /examples/… también se sirve en local, para probar la importación
    const file = p.startsWith("/examples/") ? join(root, decodeURIComponent(p)) : join(root, "public", p === "/" ? "index.html" : p);
    if (!existsSync(file)) return new Response("No encontrado", { status: 404 });
    return new Response(readFileSync(file), { headers: { "content-type": TYPES[extname(file)] || "application/octet-stream" } });
  },
};

const PORT = Number(process.env.PORT || 8787);
const env = {
  DB, ASSETS, PUBLIC_URL: `http://localhost:${PORT}`, ALERT_EMAIL: "",
  ADMIN_PASSWORD: "local-dev", ENC_KEY: "local-dev-key", DRY_RUN: "1",
  GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", MS_CLIENT_ID: "", MS_CLIENT_SECRET: "",
};

const worker = (await import("../src/index.ts")).default;

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(
    new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }),
    env,
  );
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  // Cookie Secure no viaja por http://localhost en algunos navegadores
  if (headers["set-cookie"]) headers["set-cookie"] = headers["set-cookie"].replace("; Secure", "");
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, () => console.log(`Goteo Mail (simulación) en http://localhost:${PORT} — contraseña: local-dev`));

// Cron simulado cada 30 s (en producción, cada 5 min)
if (process.env.NO_CRON !== "1") {
  setInterval(() => worker.scheduled({}, env, { waitUntil: (p) => p.catch((e) => console.error(e)) }), 30_000);
}
