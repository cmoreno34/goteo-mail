# Goteo Mail

Herramienta independiente de **envío de email «a ritmo de persona»**: manda de uno
en uno, con huecos irregulares, dentro de un horario, con texto variado por
destinatario, seguimientos en el mismo hilo que se cortan solos si la persona
contesta, baja en un clic y seguimiento de clics.

Corre entera en **Cloudflare** (Worker + base D1 + Cron), sin servidor que mantener.
Los contactos entran por **CSV** (p. ej. exportado de una base de Notion).

---

## Qué hace contra el spam

| Medida | Detalle |
|---|---|
| Uno a uno | Cada buzón manda **como mucho 1 correo por pasada**. Nada de envíos en bloque. |
| Huecos irregulares | Reparte el tope diario en la ventana horaria con ±40 % de azar, mínimo 3 min, y de vez en cuando una pausa larga. |
| Tope **por buzón** | Suma todas las campañas que usan ese buzón (lo que miran Gmail/Outlook es el remitente). |
| Calentamiento | Buzón nuevo: empieza en 8/día y sube 4 por cada día de envío hasta su tope. |
| Horario y días | Ventana local (por defecto 9-18 h, lunes a viernes, hora de México). |
| Texto variado | Spintax `{Hola\|Buenos días\|Qué tal}`: cada contacto recibe una variante, siempre la misma. |
| Orden barajado | Al añadir contactos se barajan, para no escribir seguidos a la misma empresa. |
| Respuestas | Con Gmail/Outlook por OAuth lee la bandeja cada 30 min: quien contesta deja de recibir seguimientos **en todas las campañas**. |
| Rebotes | Detecta avisos de mailer-daemon/postmaster y aparta la dirección. |
| Baja | Enlace al pie + cabecera `List-Unsubscribe` de un clic (RFC 8058, la que exige Gmail). |
| Enfriamiento | No vuelve a escribir a un contacto en N días aunque esté en otra campaña. |
| Datos malos | Direcciones que el SMTP no puede mandar (tildes, `mailto:` pegado…) se descartan al importar y nunca taponan la cola. |
| Plantilla rota | Si usas `{Columna}` que no existe, la campaña **se pausa** en vez de mandar «Hola {Nombre}» a toda la lista. Si solo le falta el dato a un contacto, se le salta a él. |
| Fallos de línea | Freno exponencial (hasta 4 h) y **aviso por correo** a los 4 fallos seguidos. |

> Lo que de verdad decide la entrega es el **buzón/dominio autenticado (SPF, DKIM,
> DMARC)** y un volumen moderado (30-50/día por buzón). El goteo y las variantes
> ayudan, pero no sustituyen eso.

---

## Probar en local (sin enviar nada)

Requiere Node 22+.

```bash
npm install
node scripts/dev-node.mjs        # http://localhost:8787 — contraseña: local-dev
```

Simula los envíos (salen por consola) y guarda la base en `.wrangler/dev-node.sqlite`.
En *Contactos* puedes importar [`examples/contactos-ejemplo.csv`](examples/contactos-ejemplo.csv),
que imita las columnas de la base de Notion (datos inventados).

> `npm run dev` (wrangler) también sirve si tu Windows permite ejecutar `workerd.exe`.

```bash
npm test            # pruebas de spintax, huecos, ritmo, ventana horaria…
npm run typecheck
```

---

## Desplegar en Cloudflare

1. **Base de datos**
   ```bash
   npx wrangler login
   npx wrangler d1 create goteo-mail          # copia el database_id en wrangler.jsonc
   npm run db:remote
   ```
2. **Dirección pública**: pon en `wrangler.jsonc` → `vars.PUBLIC_URL` la URL final.
   Mejor un **subdominio propio** (p. ej. `goteo.tudominio.com`, en *Workers → Settings
   → Domains*): los enlaces a `*.workers.dev` tienen mala reputación en los filtros.
   `ALERT_EMAIL` = a quién avisar si un buzón se atasca.
3. **Secretos**
   ```bash
   npx wrangler secret put ADMIN_PASSWORD     # contraseña del panel
   npx wrangler secret put ENC_KEY            # cadena larga aleatoria (cifra los buzones)
   npx wrangler secret put GOOGLE_CLIENT_ID   # opcional, ver abajo
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put MS_CLIENT_ID       # opcional, ver abajo
   npx wrangler secret put MS_CLIENT_SECRET
   ```
   ⚠️ Si cambias `ENC_KEY` hay que volver a conectar todos los buzones.
4. `npm run deploy`. El Cron (`*/5 * * * *`) se activa solo.

### Conectar buzones

**Gmail con contraseña de aplicación (lo más rápido)** — en el panel, *Buzones →
SMTP*: `smtp.gmail.com`, puerto `465`, y una
[contraseña de aplicación](https://myaccount.google.com/apppasswords) (requiere
verificación en 2 pasos). Solo envía: las respuestas se marcan a mano en *Contactos*.

**Gmail / Google Workspace por OAuth (envía y detecta respuestas)**
1. [Google Cloud Console](https://console.cloud.google.com/) → proyecto nuevo →
   habilita **Gmail API**.
2. *Pantalla de consentimiento OAuth*: si todos los buzones son del mismo Google
   Workspace, elige **Interno** (sin revisión de Google y sin caducidad). Con
   cuentas @gmail.com tiene que ser **Externo** en modo *Prueba* y añadir cada
   cuenta como usuario de prueba; en ese modo Google **caduca el permiso cada 7
   días** y hay que reconectar (para evitarlo habría que pasar la verificación de Google).
3. *Credenciales → ID de cliente OAuth → Aplicación web*, URI de redirección:
   `https://TU-URL/oauth/google/callback`.

**Outlook / Microsoft 365 por OAuth** (Microsoft ya no admite SMTP con contraseña)
1. [Azure Portal → App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps)
   → *New registration*, tipo de cuenta: **cualquier organización y cuentas personales**.
2. *Redirect URI* (Web): `https://TU-URL/oauth/microsoft/callback`.
3. *Certificates & secrets* → nuevo secreto. *API permissions* (delegados):
   `Mail.Send`, `Mail.Read`, `User.Read`, `offline_access`. Son permisos que
   cada usuario concede para su propio buzón; no requieren consentimiento de
   administrador salvo que la organización lo haya restringido.

Después de conectar cualquier buzón: **Enviar prueba** a una dirección tuya y
comprueba que llega a la bandeja principal.

---

## Uso

1. **Contactos → Importar CSV.** En Notion: `···` de la base → *Export* →
   *Markdown & CSV*. Elige la columna del email y la del nombre; **todas las
   demás columnas se guardan** y sirven como huecos (`{Cargo}`, `{Ciudad}`,
   `{Tipo de empresa}`…). Las filas sin email (contactos solo de LinkedIn) se ignoran.
   Reimportar la misma base actualiza los datos sin duplicar (la clave es el email).
2. **Campañas → Crear.** Elige buzones, horario, enlace principal (`{enlace}`) y
   escribe la secuencia: correo 1 + seguimientos (asunto vacío = «Re: …» en el
   mismo hilo). *Vista previa* enseña el correo real de un contacto y cuántas
   variantes distintas salen.
3. **Añadir contactos** con filtros por columna, p. ej. *solo si* `Tipo de empresa`
   = Sello, *excluir si* `Última acción` = Respuesta recibida / Reunión acordada.
4. **Activar goteo.** El panel muestra contactados, respuestas, clics, bajas,
   rebotes y apartados, y el motivo de cualquier parada.

### Firmas, fotos y botones (como en el CRM)

- **Firma con imagen** por buzón (*Buzones*): sube el PNG/JPG de la firma y elige el
  ancho (420 px es tamaño firma). Puede llevar además una firma en texto.
  Una campaña puede usar su propia firma o ninguna (*Diseño del correo*).
- **Imagen de cabecera** por campaña, arriba del correo.
- **Fotos dentro del texto**: botón *Foto* del editor → inserta `[imagen:N]`.
- **Botón**: el enlace principal (`{enlace}`, o la primera URL del texto) sale como
  un botón («Solicitar información», texto y color configurables), no como una
  dirección larga. Botón *a prueba de Outlook* (tabla con `bgcolor`).
- **Formato**: `**negrita**`, `[azul]texto[/azul]` (rojo, azul, verde, naranja,
  morado, gris) y `[texto](https://…)` para enlazar un texto. Lo insertan los
  botones del editor.

Las imágenes van **incrustadas** (`cid:`), no enlazadas: una imagen remota la
bloquean muchos clientes y un `data:` lo borran Gmail y Outlook. Máximo 400 KB
cada una (el panel reduce solo las que pesan más).

Huecos disponibles: `{nombre}` (nombre de pila), `{nombre_completo}`, `{email}`,
`{remitente}`, `{enlace}` y cualquier columna del CSV (sin distinguir mayúsculas ni tildes).

---

## Estructura

```
src/index.ts      rutas: panel (/api), clics (/l/…), bajas (/u/…), OAuth
src/drip.ts       el goteo (cron): elige, envía, frena, avisa, lee respuestas
src/pacing.ts     ritmo: ventana, huecos, calentamiento, freno, errores legibles
src/template.ts   spintax, huecos, validación de emails
src/html.ts       texto del editor → HTML: botón, negrita, colores, fotos, firma
src/compose.ts    monta el correo final con sus imágenes incrustadas
src/providers.ts  SMTP (worker-mailer), Gmail API, Microsoft Graph
src/mime.ts       mensaje MIME (cabeceras de baja e hilo, imágenes cid:)
migrations/       esquema D1
public/           panel (HTML + JS sin dependencias)
scripts/dev-node.mjs  servidor local de pruebas (simulado)
```

---

© 2026 César Moreno. Todos los derechos reservados. Ver [LICENSE](LICENSE).
