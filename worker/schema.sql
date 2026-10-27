-- Base D1 compartida por el Worker (cron) y la web (Pages Functions).
CREATE TABLE IF NOT EXISTS farm_latest (
  farm_id INTEGER PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  data TEXT NOT NULL
);

-- Una foto por día (la última del día pisa a la anterior).
CREATE TABLE IF NOT EXISTS snapshots (
  farm_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  coins REAL,
  flower REAL,
  activity TEXT,
  inventory TEXT,
  PRIMARY KEY (farm_id, day)
);

CREATE TABLE IF NOT EXISTS prices (
  taken_at TEXT PRIMARY KEY,
  flower_usd REAL,
  prices TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  farm_id INTEGER NOT NULL,
  fulfilled_at INTEGER NOT NULL,
  items TEXT,
  flower REAL,
  tax REAL
);

CREATE TABLE IF NOT EXISTS timers (
  farm_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  ready_at INTEGER NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (farm_id, key)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Ajustes de la web (meta, comisiones, anotaciones) para que el Worker y otros dispositivos los vean.
CREATE TABLE IF NOT EXISTS settings (
  farm_id INTEGER PRIMARY KEY,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_farm ON sales (farm_id, fulfilled_at);
CREATE INDEX IF NOT EXISTS idx_timers_ready ON timers (farm_id, notified, ready_at);
