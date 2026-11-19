import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHtml, buildText, buttonUrl } from "../src/html.ts";
import { buildMime } from "../src/mime.ts";

const opts = { buttonText: "Solicitar información", buttonColor: "#1d4ed8", imgSrc: (id: number) => (id === 7 ? "cid:img7@goteo" : null) };

test("la primera URL suelta es el botón; [texto](url) no", () => {
  const body = "Mira [la web](https://a.test/w).\n\nAquí: https://docs.test/p.\n\nGracias";
  assert.equal(buttonUrl(body), "https://docs.test/p");
  const h = buildHtml(body, opts);
  assert.match(h, /<td bgcolor="#1d4ed8"[^>]*><a href="https:\/\/docs\.test\/p"[^>]*>Solicitar información<\/a>/);
  assert.match(h, /<a href="https:\/\/a\.test\/w"[^>]*>la web<\/a>/);
  assert.ok(!h.includes(">https://docs.test/p<"), "la URL larga no debe verse");
  const t = buildText(body, { buttonText: "Solicitar información" });
  assert.match(t, /Solicitar información: https:\/\/docs\.test\/p/);
  assert.match(t, /la web \(https:\/\/a\.test\/w\)/);
});

test("negrita, colores y fotos", () => {
  const h = buildHtml("**Hola** [rojo]urgente[/rojo]\n[imagen:7]\n[imagen:99]", opts);
  assert.match(h, /<strong>Hola<\/strong>/);
  assert.match(h, /<span style="color:#b91c1c;">urgente<\/span>/);
  assert.match(h, /<img src="cid:img7@goteo"/);
  assert.ok(!h.includes("[imagen:99]") && !h.includes("imagen:99"));
});

test("sin texto de botón, el enlace va como enlace normal", () => {
  const h = buildHtml("Ver https://docs.test/p", { ...opts, buttonText: "" });
  assert.ok(!h.includes("bgcolor"));
  assert.match(h, /<a href="https:\/\/docs\.test\/p"/);
});

test("el HTML del usuario se escapa", () => {
  const h = buildHtml("<script>x</script>", opts);
  assert.ok(!h.includes("<script>"));
});

test("firma, cabecera y baja", () => {
  const h = buildHtml("Hola", { ...opts, header: { src: "cid:h", width: 500 }, signature: { src: "cid:s", width: 300 }, unsubscribeUrl: "https://g.test/u/x" });
  assert.ok(h.indexOf("cid:h") < h.indexOf("Hola") && h.indexOf("Hola") < h.indexOf("cid:s") && h.indexOf("cid:s") < h.indexOf("dese de baja"));
});

test("MIME con imágenes incrustadas: multipart/related con Content-ID", () => {
  const m = buildMime({
    fromName: "Laura Pérez", fromEmail: "l@x.test", to: "a@b.test", subject: "Año nuevo", text: "t", html: "<img src=\"cid:img7@goteo\">",
    messageId: "<1@x.test>", headers: { "List-Unsubscribe": "<https://g.test/u/x>" },
    inline: [{ cid: "img7@goteo", mime: "image/png", b64: "iVBORw0KGgo=", name: "firma.png" }],
  });
  assert.match(m, /multipart\/alternative/);
  assert.match(m, /multipart\/related/);
  assert.match(m, /Content-ID: <img7@goteo>/);
  assert.match(m, /Subject: =\?UTF-8\?B\?/);
  assert.match(m, /From: =\?UTF-8\?B\?[^?]+\?= <l@x\.test>/);
});
