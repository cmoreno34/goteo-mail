// El goteo. Lo llama el Cron Trigger cada 5 min; cada buzón manda COMO MUCHO
// un correo por pasada y su ritmo real lo marca `accounts.next_at` (huecos
// irregulares), no la frecuencia del cron.
//
// Lecciones heredadas del goteo del CRM:
//  · Una dirección imposible es un dato malo, no un fallo de envío: se aparta
//    ANTES de tocar el buzón para que no tapone la cola.
//  · Cola rotatoria: el que falla pasa al final (`attempts`), nunca se queda
//    clavado el primero.
//  · Freno exponencial SOLO para caídas de línea, y aviso a los 4 fallos
//    seguidos (un goteo parado en silencio durante días es el peor fallo).
//  · Un hueco {Columna} que nadie sabe rellenar PARA la campaña: mejor parar
//    que mandar «Hola {Nombre}» a toda la lista.
import type { Env } from "./env.ts";
import { decrypt, randomToken } from "./crypto.ts";
import { newMessageId } from "./mime.ts";
import {
  ALERT_AFTER_FAILS,
  backoffMs,
  effectiveCap,
  followUpDueMs,
  humanError,
  inWindow,
  isRecipientError,
  nextGapMs,
  startOfLocalDay,
  type Window,
} from "./pacing.ts";
import { inboxSince, isBounceSender, sendMessage, type AccountRow } from "./providers.ts";
import {
  EMAIL_OK,
  findUrls,
  normKey,
  placeholderValues,
  render,
  replaceUrls,
  textToHtml,
} from "./template.ts";
import { compose, type ComposeCampaign } from "./compose.ts";

const MAX_ACCOUNTS_PER_TICK = 3;
const REPLY_CHECK_EVERY_MS = 30 * 60_000;

export async function logEvent(
  env: Env,
  message: string,
  o: { level?: string; campaign_id?: number | null; account_id?: number | null } = {},
) {
  await env.DB.prepare("INSERT INTO events (at, level, campaign_id, account_id, message) VALUES (?,?,?,?,?)")
    .bind(Date.now(), o.level || "info", o.campaign_id ?? null, o.account_id ?? null, message.slice(0, 1000))
    .run();
}

async function setting(env: Env, key: string, def: string): Promise<string> {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? def;
}

export async function loadAccount(env: Env, id: number): Promise<(AccountRow & Record<string, unknown>) | null> {
  const a = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!a) return null;
  return { ...(a as unknown as AccountRow), ...a, secret: await decrypt(String(a.secret_enc), env.ENC_KEY) };
}

interface CampaignRow extends ComposeCampaign {
  id: number;
  name: string;
  tz: string;
  window_start: number;
  window_end: number;
  days: string;
  track_links: number;
  main_link: string;
}

function windowOf(c: CampaignRow): Window {
  return { tz: c.tz, start: c.window_start, end: c.window_end, days: c.days };
}

export async function runTick(env: Env, now = Date.now()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { sent: 0, accounts: [] as unknown[] };
  const accounts = (
    await env.DB.prepare(
      "SELECT id FROM accounts WHERE active = 1 AND next_at <= ? ORDER BY next_at ASC LIMIT ?",
    )
      .bind(now, MAX_ACCOUNTS_PER_TICK)
      .all<{ id: number }>()
  ).results;

  for (const { id } of accounts) {
    try {
      const r = await tickAccount(env, id, now);
      (out.accounts as unknown[]).push({ id, ...r });
      if (r.sent) out.sent = (out.sent as number) + 1;
    } catch (e) {
      await logEvent(env, `Error inesperado en el buzón ${id}: ${String(e)}`, { level: "error", account_id: id });
    }
  }

  try {
    await checkReplies(env, now);
  } catch (e) {
    await logEvent(env, `Error leyendo respuestas: ${String(e)}`, { level: "error" });
  }
  await closeFinishedCampaigns(env);
  return out;
}

async function tickAccount(env: Env, accountId: number, now: number): Promise<{ sent?: boolean; why?: string }> {
  const acc = await loadAccount(env, accountId);
  if (!acc) return { why: "no existe" };

  const camps = (
    await env.DB.prepare(
      `SELECT * FROM campaigns c WHERE status = 'active'
       AND EXISTS (SELECT 1 FROM json_each(c.account_ids) WHERE value = ?)`,
    )
      .bind(accountId)
      .all<CampaignRow>()
  ).results.filter((c) => inWindow(now, windowOf(c)));
  if (!camps.length) return { why: "fuera de horario o sin campañas" };

  // Tope diario del BUZÓN (sumando todas sus campañas), con calentamiento.
  const tz = camps[0].tz;
  const dayStart = startOfLocalDay(now, tz);
  const sentToday =
    (await env.DB.prepare("SELECT COUNT(*) n FROM sends WHERE account_id = ? AND sent_at >= ?")
      .bind(accountId, dayStart)
      .first<{ n: number }>())?.n || 0;
  const activeDays =
    (await env.DB.prepare(
      "SELECT COUNT(DISTINCT date(sent_at/1000,'unixepoch')) n FROM sends WHERE account_id = ? AND sent_at < ?",
    )
      .bind(accountId, dayStart)
      .first<{ n: number }>())?.n || 0;
  const cap = effectiveCap(Number(acc.daily_cap), Boolean(acc.warmup), activeDays);
  if (sentToday >= cap) return { why: `tope de hoy alcanzado (${sentToday}/${cap})` };

  const cooldownDays = Number(await setting(env, "cooldown_days", "7"));
  const ids = camps.map((c) => c.id);
  const ph = ids.map(() => "?").join(",");
  const next = await env.DB.prepare(
    `SELECT e.*, ct.email, ct.name, ct.fields
     FROM enrollments e JOIN contacts ct ON ct.id = e.contact_id
     WHERE e.campaign_id IN (${ph}) AND e.status = 'pending' AND e.due_at <= ?
       AND (e.account_id IS NULL OR e.account_id = ?)
       AND ct.unsubscribed_at IS NULL AND ct.bounced_at IS NULL AND ct.replied_at IS NULL
       AND (e.next_step > 1 OR ct.last_contacted_at IS NULL OR ct.last_contacted_at < ?)
     ORDER BY e.attempts ASC, e.next_step DESC, e.due_at ASC, e.id ASC
     LIMIT 1`,
  )
    .bind(...ids, now, accountId, now - cooldownDays * 86_400_000)
    .first<Record<string, unknown>>();
  if (!next) return { why: "nadie pendiente" };

  const camp = camps.find((c) => c.id === next.campaign_id) as CampaignRow;
  const enrollId = Number(next.id);
  const email = String(next.email);

  // Dato malo → se aparta sin tocar el buzón.
  if (!EMAIL_OK.test(email)) {
    await env.DB.prepare("UPDATE enrollments SET status='error', last_error=? WHERE id=?")
      .bind("Dirección no válida para enviar", enrollId)
      .run();
    return { why: `apartado ${email}` };
  }

  const steps = (
    await env.DB.prepare("SELECT * FROM steps WHERE campaign_id = ? ORDER BY ord").bind(camp.id).all<{
      ord: number;
      delay_days: number;
      subject: string;
      body: string;
    }>()
  ).results;
  const step = steps.find((s) => s.ord === Number(next.next_step));
  if (!step) {
    await env.DB.prepare("UPDATE enrollments SET status='done' WHERE id=?").bind(enrollId).run();
    return { why: "secuencia terminada" };
  }

  const contact = {
    email,
    name: String(next.name || ""),
    fields: JSON.parse(String(next.fields || "{}")) as Record<string, string>,
  };
  const ctx = { contact, senderName: String(acc.from_name || ""), enlace: camp.main_link };
  const isFollowUp = step.ord > 1;
  const baseSubject = isFollowUp && !step.subject.trim() ? `Re: ${next.first_subject || ""}` : step.subject;
  const r = render(baseSubject, step.body, ctx, `${contact.email}:${camp.id}:${step.ord}`);

  if (r.missing.length) {
    const known = placeholderValues(ctx);
    const unknown = r.missing.filter((m) => !known.has(normKey(m)));
    if (unknown.length) {
      // Hueco que no existe en la ficha: es un error de la PLANTILLA → se para.
      const why = `La plantilla usa ${unknown.map((u) => `{${u}}`).join(", ")}, que no existe en los contactos. Corrígelo y reanuda.`;
      await env.DB.prepare("UPDATE campaigns SET status='paused', stopped_reason=? WHERE id=?").bind(why, camp.id).run();
      await logEvent(env, why, { level: "error", campaign_id: camp.id });
      return { why: "plantilla con huecos" };
    }
    // Existe pero este contacto lo tiene vacío → se salta solo a él.
    await env.DB.prepare("UPDATE enrollments SET status='skipped', last_error=? WHERE id=?")
      .bind(`Sin dato para ${r.missing.map((m) => `{${m}}`).join(", ")}`, enrollId)
      .run();
    return { why: "contacto sin datos" };
  }

  let body = r.body;

  // Enlaces de seguimiento
  const createdLinks: string[] = [];
  if (camp.track_links && env.PUBLIC_URL) {
    const map = new Map<string, string>();
    for (const url of findUrls(body)) {
      if (url.startsWith(env.PUBLIC_URL)) continue;
      const code = randomToken(6);
      await env.DB.prepare("INSERT INTO links (code, enrollment_id, url) VALUES (?,?,?)").bind(code, enrollId, url).run();
      createdLinks.push(code);
      map.set(url, `${env.PUBLIC_URL}/l/${code}`);
    }
    body = replaceUrls(body, map);
  }

  const unsub = env.PUBLIC_URL ? `${env.PUBLIC_URL}/u/${next.token}` : "";
  const headers: Record<string, string> = {};
  if (unsub) {
    headers["List-Unsubscribe"] = `<${unsub}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  if (isFollowUp && next.first_message_id) {
    headers["In-Reply-To"] = String(next.first_message_id);
    headers["References"] = String(next.first_message_id);
  }
  const messageId = newMessageId(acc.email);

  try {
    // Firma (texto + imagen), cabecera, fotos y botón: dentro del try, que
    // una imagen rota no tumbe la pasada sin dejar rastro.
    const msg = await compose(env, { body, account: acc, campaign: camp, unsubscribeUrl: unsub, mode: "cid" });
    const res = await sendMessage(
      env,
      acc,
      {
        fromName: String(acc.from_name || ""),
        fromEmail: acc.email,
        to: email,
        subject: r.subject,
        text: msg.text,
        html: msg.html,
        inline: msg.inline,
        messageId,
        headers,
      },
      isFollowUp ? (next.thread_id as string | null) : null,
    );

    const nextStep = steps.find((s) => s.ord === step.ord + 1);
    const gap = nextGapMs(cap, windowOf(camp));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sends (enrollment_id, account_id, step, message_id, subject, sent_at) VALUES (?,?,?,?,?,?)").bind(
        enrollId, accountId, step.ord, res.messageId, r.subject, now,
      ),
      env.DB.prepare(
        `UPDATE enrollments SET account_id=?, next_step=?, status=?, due_at=?, attempts=0, last_error=NULL,
           thread_id=COALESCE(thread_id, ?), first_message_id=COALESCE(first_message_id, ?),
           first_subject=COALESCE(first_subject, ?) WHERE id=?`,
      ).bind(
        accountId,
        step.ord + 1,
        nextStep ? "pending" : "done",
        nextStep ? followUpDueMs(now, nextStep.delay_days) : 0,
        res.threadId ?? null,
        res.messageId,
        r.subject,
        enrollId,
      ),
      env.DB.prepare("UPDATE contacts SET last_contacted_at=? WHERE id=?").bind(now, next.contact_id),
      env.DB.prepare("UPDATE accounts SET next_at=?, fail_streak=0, last_error=NULL, alert_sent_at=NULL WHERE id=?").bind(
        now + gap, accountId,
      ),
    ]);
    return { sent: true, why: `${email} (paso ${step.ord}); siguiente en ${Math.round(gap / 60000)} min` };
  } catch (e) {
    const detail = String((e as Error)?.message || e);
    if (createdLinks.length) {
      await env.DB.prepare(`DELETE FROM links WHERE code IN (${createdLinks.map(() => "?").join(",")})`).bind(...createdLinks).run();
    }
    if (isRecipientError(detail)) {
      await env.DB.batch([
        env.DB.prepare("UPDATE enrollments SET status='error', last_error=? WHERE id=?").bind(detail.slice(0, 300), enrollId),
        env.DB.prepare("UPDATE accounts SET next_at=? WHERE id=?").bind(now + 180_000, accountId),
      ]);
      await logEvent(env, `Apartado ${email}: ${detail.slice(0, 200)}`, { level: "warn", campaign_id: camp.id, account_id: accountId });
      return { why: "destinatario rechazado" };
    }
    const streak = Number(acc.fail_streak || 0) + 1;
    const human = humanError(detail);
    await env.DB.batch([
      env.DB.prepare("UPDATE enrollments SET attempts = attempts + 1, last_error=? WHERE id=?").bind(detail.slice(0, 300), enrollId),
      env.DB.prepare("UPDATE accounts SET fail_streak=?, last_error=?, next_at=? WHERE id=?").bind(
        streak, human, now + backoffMs(streak), accountId,
      ),
    ]);
    await logEvent(env, `${acc.email}: fallo #${streak} — ${detail.slice(0, 300)}`, { level: "error", account_id: accountId });
    if (streak >= ALERT_AFTER_FAILS && !acc.alert_sent_at) await alertStuck(env, acc, human, now);
    return { why: `fallo de envío #${streak}` };
  }
}

/** Avisa por correo desde OTRO buzón sano (el atascado no puede avisar de sí mismo). */
async function alertStuck(env: Env, stuck: AccountRow, human: string, now: number) {
  await env.DB.prepare("UPDATE accounts SET alert_sent_at=? WHERE id=?").bind(now, stuck.id).run();
  const to = env.ALERT_EMAIL;
  if (!to) return;
  const healthy = await env.DB.prepare(
    "SELECT id FROM accounts WHERE active=1 AND fail_streak=0 AND id != ? LIMIT 1",
  )
    .bind(stuck.id)
    .first<{ id: number }>();
  if (!healthy) {
    await logEvent(env, `No hay otro buzón sano para avisar del atasco de ${stuck.email}`, { level: "error" });
    return;
  }
  const acc = await loadAccount(env, healthy.id);
  if (!acc) return;
  const text = `El buzón ${stuck.email} lleva ${ALERT_AFTER_FAILS} fallos seguidos y el goteo está parado para él.\n\n${human}\n\nPanel: ${env.PUBLIC_URL}`;
  try {
    await sendMessage(env, acc, {
      fromName: "Goteo Mail",
      fromEmail: acc.email,
      to,
      subject: `Goteo parado: ${stuck.email}`,
      text,
      html: textToHtml(text, ""),
      messageId: newMessageId(acc.email),
      headers: {},
    });
  } catch (e) {
    await logEvent(env, `No se pudo mandar el aviso: ${String(e)}`, { level: "error" });
  }
}

/** Respuestas y rebotes: paran los seguimientos de ese contacto en TODAS las campañas. */
async function checkReplies(env: Env, now: number) {
  const acc0 = await env.DB.prepare(
    `SELECT id, replies_checked_at FROM accounts
     WHERE active=1 AND provider IN ('google','microsoft') AND replies_checked_at < ?
     ORDER BY replies_checked_at ASC LIMIT 1`,
  )
    .bind(now - REPLY_CHECK_EVERY_MS)
    .first<{ id: number; replies_checked_at: number }>();
  if (!acc0) return;
  const acc = await loadAccount(env, acc0.id);
  if (!acc) return;

  const since = Math.max(acc0.replies_checked_at || 0, now - 3 * 86_400_000) - 10 * 60_000;
  const cands = (
    await env.DB.prepare(
      `SELECT DISTINCT ct.id, ct.email FROM sends s
       JOIN enrollments e ON e.id = s.enrollment_id JOIN contacts ct ON ct.id = e.contact_id
       WHERE s.account_id = ? AND s.sent_at > ? AND ct.replied_at IS NULL AND ct.bounced_at IS NULL
       ORDER BY s.sent_at DESC LIMIT 40`,
    )
      .bind(acc.id, now - 45 * 86_400_000)
      .all<{ id: number; email: string }>()
  ).results;
  await env.DB.prepare("UPDATE accounts SET replies_checked_at=? WHERE id=?").bind(now, acc.id).run();
  if (!cands.length) return;

  const hits = await inboxSince(env, acc, since, cands.map((c) => c.email));
  for (const h of hits) {
    if (isBounceSender(h.from)) {
      const victim = cands.find((c) => h.snippet.toLowerCase().includes(c.email));
      if (victim) await markContact(env, victim.id, "bounced", h.at || now, `Rebote: ${victim.email}`);
      continue;
    }
    const who = cands.find((c) => c.email === h.from);
    if (who) await markContact(env, who.id, "replied", h.at || now, `Respondió: ${who.email}`);
  }
}

export async function markContact(env: Env, contactId: number, kind: "replied" | "bounced" | "unsubscribed", at: number, msg?: string) {
  const col = kind === "replied" ? "replied_at" : kind === "bounced" ? "bounced_at" : "unsubscribed_at";
  await env.DB.batch([
    env.DB.prepare(`UPDATE contacts SET ${col}=COALESCE(${col}, ?) WHERE id=?`).bind(at, contactId),
    env.DB.prepare(`UPDATE enrollments SET status=? WHERE contact_id=? AND status='pending'`).bind(kind, contactId),
  ]);
  if (msg) await logEvent(env, msg);
}

async function closeFinishedCampaigns(env: Env) {
  await env.DB.prepare(
    `UPDATE campaigns SET status='done' WHERE status='active'
     AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.campaign_id = campaigns.id AND e.status='pending')
     AND EXISTS (SELECT 1 FROM enrollments e WHERE e.campaign_id = campaigns.id)`,
  ).run();
}
