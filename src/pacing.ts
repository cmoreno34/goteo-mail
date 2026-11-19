// Ritmo «de persona»: ventana horaria, días hábiles, huecos irregulares,
// tope diario con calentamiento y freno exponencial ante fallos de línea.
// Lógica pura, probada con `node --test`.

export interface Window {
  tz: string;
  start: number; // hora local de inicio (incl.)
  end: number; // hora local de fin (excl.)
  days: string; // "12345" (1 = lunes)
}

export function localParts(now: number, tz: string): { hour: number; weekday: number; ymd: string } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday as string] || 1;
  return { hour: Number(p.hour), weekday: wd, ymd: `${p.year}-${p.month}-${p.day}` };
}

export function inWindow(now: number, w: Window): boolean {
  const { hour, weekday } = localParts(now, w.tz);
  return w.days.includes(String(weekday)) && hour >= w.start && hour < w.end;
}

/** Inicio del día local (epoch ms) — para contar «enviados hoy». */
export function startOfLocalDay(now: number, tz: string): number {
  // Retrocede hasta que cambie la fecha local; precisión de minuto es suficiente.
  const today = localParts(now, tz).ymd;
  let lo = now - 26 * 3600_000;
  let hi = now;
  while (hi - lo > 60_000) {
    const mid = Math.floor((lo + hi) / 2);
    if (localParts(mid, tz).ymd === today) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Tope efectivo hoy. Con calentamiento, un buzón nuevo empieza en 8/día y
 * sube ~4 cada día hábil de envío hasta su tope: un salto de 0 a 50 correos
 * en frío es justo lo que penalizan Gmail y Outlook.
 */
export function effectiveCap(dailyCap: number, warmup: boolean, activeDays: number): number {
  if (!warmup) return dailyCap;
  return Math.min(dailyCap, 8 + 4 * Math.max(0, activeDays));
}

/**
 * Hueco hasta el siguiente envío del buzón: reparte el tope a lo largo de la
 * ventana con ±40 % de azar y nunca menos de 3 min. Además, de vez en cuando
 * (1 de cada 8) mete una «pausa de café» más larga, como haría una persona.
 */
export function nextGapMs(cap: number, w: Window, rnd: () => number = Math.random): number {
  const horas = Math.max(1, w.end - w.start);
  const base = (horas * 3600_000) / Math.max(1, cap);
  let gap = base * (0.6 + rnd() * 0.8);
  if (rnd() < 0.125) gap += (10 + rnd() * 25) * 60_000;
  return Math.max(180_000, Math.round(gap));
}

/** Espera tras N fallos seguidos de línea: se dobla, tope 4 h. */
export function backoffMs(failStreak: number, baseMs = 20 * 60_000): number {
  return Math.min(4 * 3600_000, Math.round(baseMs * 2 ** Math.min(Math.max(failStreak - 1, 0), 4)));
}

/** Aviso por correo a partir de este número de fallos seguidos. */
export const ALERT_AFTER_FAILS = 4;

/** Retraso de un seguimiento: los días pedidos + unas horas al azar. */
export function followUpDueMs(fromMs: number, delayDays: number, rnd: () => number = Math.random): number {
  return fromMs + delayDays * 86_400_000 + Math.round(rnd() * 4 * 3600_000);
}

/** El fallo dicho de forma que se sepa QUÉ hacer (distingue causas opuestas). */
export function humanError(detail: string): string {
  const d = (detail || "").toLowerCase();
  if (/timeout|timed out|not connected|disconnected|connection (refused|reset)|socket/.test(d)) {
    return "El servidor de correo no deja conectar. Suele ser un bloqueo temporal; se reintenta solo, cada vez más espaciado.";
  }
  if (/invalid_grant|token.*(expired|revoked)|unauthorized|401/.test(d)) {
    return "El permiso del buzón ha caducado o se ha retirado. Vuelve a conectarlo en «Buzones».";
  }
  if (/authentication|username and password|535|534/.test(d)) {
    return "El buzón rechaza la contraseña. En Gmail hace falta una «contraseña de aplicación», no la normal.";
  }
  if (/quota|rate|429|limit|too many|421|4\.7\.0|5\.4\.5|550 5\.4\.5/.test(d)) {
    return "El proveedor ha frenado el buzón por volumen. Baja el tope diario; el goteo espera y sigue solo.";
  }
  if (/smtputf8|internationalized/.test(d)) {
    return "Una dirección lleva tildes o ñ, que el servidor no admite.";
  }
  return `El servidor de correo devolvió un error: ${(detail || "").slice(0, 300)}`;
}

/** ¿El error es del DESTINATARIO (dato malo) y no de la línea? */
export function isRecipientError(detail: string): boolean {
  const d = (detail || "").toLowerCase();
  return /recipient|mailbox (unavailable|not found)|user unknown|no such user|550 5\.1\.|invalid address|5\.1\.1|5\.1\.3|smtputf8/.test(d);
}
