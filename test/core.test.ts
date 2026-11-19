import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEmail, expandSpintax, render, spintaxVariants, findUrls, firstName } from "../src/template.ts";
import { backoffMs, effectiveCap, inWindow, isRecipientError, nextGapMs, startOfLocalDay } from "../src/pacing.ts";

const ctx = (fields: Record<string, string> = {}) => ({
  contact: { email: "a@b.com", name: "MARCO IBARRA", fields },
  senderName: "Laura",
  enlace: "https://x.test/p",
});

test("spintax es estable por semilla y respeta los huecos", () => {
  const t = "{Hola|Buenas|Qué tal} {nombre}";
  assert.equal(expandSpintax(t, "s1"), expandSpintax(t, "s1"));
  assert.match(expandSpintax(t, "s1"), /\{nombre\}$/);
  const seen = new Set(Array.from({ length: 50 }, (_, i) => expandSpintax(t, `s${i}`)));
  assert.equal(seen.size, 3);
  assert.equal(spintaxVariants("{a|b} {c|d|e} {nombre}"), 6);
});

test("huecos: columnas del CSV sin distinguir mayúsculas ni tildes", () => {
  const r = render("{Cargo} en {Ciudad}", "Hola {Nombre}, {enlace} — {remitente}", ctx({ Cargo: "A&R", "Ciudad": "CDMX" }), "x");
  assert.equal(r.subject, "A&R en CDMX");
  assert.equal(r.body, "Hola Marco, https://x.test/p — Laura");
  assert.deepEqual(r.missing, []);
  const r2 = render("Hola", "{Tipo de empresa} {Teléfono}", ctx({ "Tipo de empresa": "Sello", "Teléfono": "" }), "x");
  assert.deepEqual(r2.missing, ["Teléfono"]);
});

test("emails: se descartan los que el SMTP no puede mandar", () => {
  assert.equal(cleanEmail(" Mailto:Ana@Sello.MX "), "ana@sello.mx");
  assert.equal(cleanEmail("Ana <ana@sello.mx>"), "ana@sello.mx");
  assert.equal(cleanEmail("ivan.príeto@x.com"), null);
  assert.equal(cleanEmail("[email protected]"), null);
  assert.equal(cleanEmail(""), null);
});

test("firstName y urls", () => {
  assert.equal(firstName("LAURA PÉREZ"), "Laura");
  assert.deepEqual(findUrls("ver https://docs.google.com/p/1. y (https://a.test/x)"), ["https://docs.google.com/p/1", "https://a.test/x"]);
});

test("ritmo: huecos irregulares, mínimo 3 min, tope con calentamiento", () => {
  const w = { tz: "America/Mexico_City", start: 9, end: 18, days: "12345" };
  const gaps = Array.from({ length: 200 }, () => nextGapMs(30, w));
  assert.ok(Math.min(...gaps) >= 180_000);
  assert.ok(new Set(gaps).size > 150);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length / 60000;
  assert.ok(avg > 15 && avg < 30, `media ${avg}`);
  assert.equal(effectiveCap(40, true, 0), 8);
  assert.equal(effectiveCap(40, true, 3), 20);
  assert.equal(effectiveCap(40, true, 30), 40);
  assert.equal(effectiveCap(40, false, 0), 40);
  assert.equal(backoffMs(1), 20 * 60_000);
  assert.equal(backoffMs(10), 4 * 3600_000);
});

test("ventana horaria en hora de México", () => {
  const w = { tz: "America/Mexico_City", start: 9, end: 18, days: "12345" };
  assert.equal(inWindow(Date.parse("2026-11-19T16:00:00Z"), w), true); // jueves 10:00 MX
  assert.equal(inWindow(Date.parse("2026-11-19T03:00:00Z"), w), false); // miércoles 21:00 MX
  assert.equal(inWindow(Date.parse("2026-11-21T17:00:00Z"), w), false); // sábado
  const s = startOfLocalDay(Date.parse("2026-11-19T16:00:00Z"), "America/Mexico_City");
  assert.ok(Math.abs(s - Date.parse("2026-11-19T06:00:00Z")) <= 60_000);
});

test("errores de destinatario vs de línea", () => {
  assert.equal(isRecipientError("550 5.1.1 Recipient address rejected"), true);
  assert.equal(isRecipientError("Socket timed out"), false);
});
