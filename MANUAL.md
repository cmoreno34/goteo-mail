# Goteo Mail · Mini manual

**Panel:** https://goteo-mail.cmoreno-837.workers.dev
(la contraseña se pide al administrador; es la misma para todos)

Goteo Mail manda correos **de uno en uno y a ritmo de persona** (con huecos
irregulares, en horario de oficina y con el texto un poco distinto para cada
contacto) para no caer en spam. Si alguien contesta, deja de escribirle solo.

---

## 1. Conectar tu buzón (una vez)

*Buzones* → elige una opción:

- **Gmail (rápido):** formulario SMTP → tu email, servidor `smtp.gmail.com`,
  puerto `465` y una **contraseña de aplicación**. Se crea en
  https://myaccount.google.com/apppasswords (necesitas la verificación en 2 pasos
  activada). No es tu contraseña normal.
- **Outlook / Microsoft 365 o Gmail con lectura de respuestas:** botones
  *Conectar…* (si aparecen en gris, aún no están activados: pídelo al administrador).

Después, en la tarjeta del buzón:
- **Nombre del remitente** (p. ej. *Laura Pérez*).
- **Firma**: en texto y/o **Subir imagen** (logo + datos). 420 px de ancho es tamaño firma.
- **Tope diario**: 30-40. Deja marcado **Calentamiento** si el buzón es nuevo.
- **Guardar** → escribe tu email → **Enviar prueba**. Comprueba que llega a la
  bandeja principal (no a spam) y que la firma se ve bien.

## 2. Importar los contactos

1. En Notion: `···` de la base → **Export** → *Markdown & CSV* → descomprime.
2. *Contactos* → **Importar CSV** → elige el `.csv`.
3. Comprueba que la **columna del email** y la del **nombre** son las correctas → **Importar**.

Las filas sin email (contactos solo de LinkedIn) se ignoran. Si vuelves a importar
la misma base, se actualiza sin duplicar.

## 3. Crear la campaña

*Campañas* → nombre → **Crear**. Dentro:

- **Ajustes:** horario (p. ej. 9 a 18), días (L-V), **buzón** que envía y el
  **enlace principal** (p. ej. la presentación de Google Slides).
- **Diseño del correo:** texto del **botón** (*Ver la presentación*…), imagen de
  **cabecera** si quieres, y la **firma** (la del buzón por defecto).
- **Secuencia:** asunto y texto del **Correo 1** + seguimientos (*+ Añadir
  seguimiento*, con los días de espera). Un seguimiento con el asunto vacío va
  como respuesta en el mismo hilo.
- **Vista previa** para ver el correo tal cual llegará → **Guardar**.

### Escribir el texto

| Escribes | Sale |
|---|---|
| `{nombre}` | el nombre de pila del contacto |
| `{Cargo}`, `{Empresa}`, `{Ciudad}`… | cualquier columna de Notion |
| `{Hola\|Buenos días\|Qué tal}` | una de las opciones (cada contacto la suya) |
| `{enlace}` | el **botón** con el enlace principal |
| `{remitente}` | tu nombre |

Los botones del editor añaden **negrita**, colores, un enlace sobre un texto, el
botón y fotos. Usa varias `{opciones|distintas}`: la vista previa avisa si salen
pocas combinaciones.

> Si un contacto no tiene el dato de un hueco (p. ej. sin `{Cargo}`), se le salta.
> Si pones un hueco que no existe, la campaña se pausa y te dice cuál es.

## 4. Elegir a quién y activar

1. En la campaña, bloque **Añadir contactos**: lista, y filtros
   *Solo si…* (p. ej. `Tipo de empresa` = Sello) o *Excluir si…*
   (p. ej. `Última acción` = Respuesta recibida, Reunión acordada).
2. **Contar** → **Añadir a la campaña**.
3. Arriba a la derecha: **Activar goteo**.

## 5. Seguimiento

- La campaña muestra **contactados, respuestas, clics, bajas y rebotes**, y en
  *Destinatarios* el estado de cada persona.
- **Resumen** enseña la actividad y los avisos (buzón con fallos, campaña pausada).
- Si alguien te contesta y tu buzón es SMTP, márcalo en *Contactos* →
  **Marcar respondido** para que no reciba más seguimientos.
- **Pausar** detiene la campaña; **Activar goteo** la reanuda donde iba.

## Buenas prácticas

- 30-40 correos al día por buzón como mucho. Para más volumen, más buzones.
- Textos cortos, personales y sin adjuntos.
- Manda siempre una prueba antes de activar.
- No hace falta tener el ordenador encendido: el goteo funciona solo en la nube.
