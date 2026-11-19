-- Goteo Mail — esquema inicial (D1 / SQLite)

-- Buzones desde los que se envía. Cada uno lleva su propio ritmo: el freno
-- antispam es POR BUZÓN (lo que miran Gmail/Outlook es cuánto manda cada
-- remitente), no por campaña.
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider      TEXT NOT NULL CHECK (provider IN ('smtp','google','microsoft')),
  email         TEXT NOT NULL UNIQUE,
  from_name     TEXT NOT NULL DEFAULT '',
  signature     TEXT NOT NULL DEFAULT '',
  smtp_host     TEXT,
  smtp_port     INTEGER,
  smtp_user     TEXT,
  secret_enc    TEXT NOT NULL,            -- contraseña de app o refresh token, cifrado AES-GCM
  daily_cap     INTEGER NOT NULL DEFAULT 30,
  warmup        INTEGER NOT NULL DEFAULT 1, -- 1 = calentamiento: empieza en 8/día y sube
  active        INTEGER NOT NULL DEFAULT 1,
  next_at       INTEGER NOT NULL DEFAULT 0, -- epoch ms: no envía antes de esto
  fail_streak   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  alert_sent_at INTEGER,
  replies_checked_at INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- Contactos importados (CSV de Notion u otro). Las columnas originales van en
-- `fields` (JSON) y todas sirven como huecos: {Cargo}, {Ciudad}, {Tipo de empresa}…
CREATE TABLE contacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,     -- en minúsculas
  name          TEXT NOT NULL DEFAULT '',
  fields        TEXT NOT NULL DEFAULT '{}',
  list          TEXT NOT NULL DEFAULT '', -- etiqueta de la importación
  unsubscribed_at INTEGER,
  bounced_at    INTEGER,
  replied_at    INTEGER,
  last_contacted_at INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX contacts_list ON contacts(list);

CREATE TABLE campaigns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','done')),
  account_ids   TEXT NOT NULL DEFAULT '[]', -- buzones que reparten la lista (JSON)
  tz            TEXT NOT NULL DEFAULT 'America/Mexico_City',
  window_start  INTEGER NOT NULL DEFAULT 9,
  window_end    INTEGER NOT NULL DEFAULT 18,
  days          TEXT NOT NULL DEFAULT '12345', -- 1 = lunes … 7 = domingo
  track_links   INTEGER NOT NULL DEFAULT 1,
  main_link     TEXT NOT NULL DEFAULT '',      -- lo que vale {enlace}
  stopped_reason TEXT,
  created_at    INTEGER NOT NULL
);

-- Secuencia: paso 1 = primer correo; los siguientes son seguimientos en el
-- MISMO hilo, que solo salen si no ha contestado.
CREATE TABLE steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id   INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,
  delay_days    INTEGER NOT NULL DEFAULT 0, -- días desde el paso anterior
  subject       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  UNIQUE (campaign_id, ord)
);

CREATE TABLE enrollments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id   INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id    INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id    INTEGER,                 -- se fija en el primer envío: todo el hilo sale del mismo buzón
  token         TEXT NOT NULL UNIQUE,    -- baja + enlaces de seguimiento
  next_step     INTEGER NOT NULL DEFAULT 1,
  due_at        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','done','replied','unsubscribed','bounced','skipped','error')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  thread_id     TEXT,                    -- hilo de Gmail / conversación de Outlook
  first_message_id TEXT,                 -- Message-ID del primer correo (In-Reply-To)
  first_subject TEXT,
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX enrollments_due ON enrollments(campaign_id, status, due_at);

CREATE TABLE sends (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  account_id    INTEGER NOT NULL,
  step          INTEGER NOT NULL,
  message_id    TEXT,
  subject       TEXT,
  sent_at       INTEGER NOT NULL
);
CREATE INDEX sends_account_day ON sends(account_id, sent_at);

CREATE TABLE links (
  code          TEXT PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  clicks        INTEGER NOT NULL DEFAULT 0,
  first_click_at INTEGER,
  last_click_at INTEGER
);
CREATE INDEX links_enrollment ON links(enrollment_id);

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  level         TEXT NOT NULL DEFAULT 'info',
  campaign_id   INTEGER,
  account_id    INTEGER,
  message       TEXT NOT NULL
);
CREATE INDEX events_at ON events(at);

CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
