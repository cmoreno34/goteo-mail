-- Firmas con imagen, fotos y botones (como el CRM).

-- Imágenes subidas desde el panel: firmas, cabeceras y fotos dentro del texto.
-- Van en la base (máx. 400 KB cada una) y en el correo se incrustan (cid:),
-- que es lo único que ven todos los clientes: una URL remota la bloquean
-- muchos por defecto y un data: URI lo borran Gmail y Outlook.
CREATE TABLE images (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL DEFAULT '',
  mime        TEXT NOT NULL,
  data_b64    TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

ALTER TABLE accounts ADD COLUMN signature_image_id INTEGER;
ALTER TABLE accounts ADD COLUMN signature_width INTEGER NOT NULL DEFAULT 420;

ALTER TABLE campaigns ADD COLUMN button_text TEXT NOT NULL DEFAULT 'Solicitar información';
ALTER TABLE campaigns ADD COLUMN button_color TEXT NOT NULL DEFAULT '#1d4ed8';
ALTER TABLE campaigns ADD COLUMN header_image_id INTEGER;
ALTER TABLE campaigns ADD COLUMN header_width INTEGER NOT NULL DEFAULT 560;
-- Firma propia de la campaña: manda sobre la del buzón. 0 = sin firma de imagen.
ALTER TABLE campaigns ADD COLUMN signature_image_id INTEGER;
ALTER TABLE campaigns ADD COLUMN signature_width INTEGER;
