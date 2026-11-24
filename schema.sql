PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('productor','comprador','organizacion','admin')),
  name TEXT NOT NULL, comuna TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
  photo TEXT NOT NULL DEFAULT '', created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY, producer INTEGER NOT NULL REFERENCES users(id),
  product TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
  kg INTEGER NOT NULL CHECK(kg > 0), available INTEGER NOT NULL CHECK(available BETWEEN 0 AND kg),
  price INTEGER NOT NULL CHECK(price >= 0), comuna TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('fresh','future','donation')),
  quality TEXT NOT NULL, harvest TEXT NOT NULL, deadline TEXT NOT NULL,
  photo TEXT NOT NULL DEFAULT '', lat REAL, lon REAL,
  created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, lot INTEGER NOT NULL REFERENCES lots(id),
  buyer INTEGER NOT NULL REFERENCES users(id), kg INTEGER NOT NULL CHECK(kg > 0),
  total INTEGER NOT NULL, deposit INTEGER NOT NULL, commission INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  amount INTEGER NOT NULL, kind TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'test',
  created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY, recipient INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, dedupe TEXT,
  UNIQUE(recipient, dedupe)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, actor INTEGER REFERENCES users(id),
  subject TEXT NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS losses (
  id INTEGER PRIMARY KEY, producer INTEGER NOT NULL REFERENCES users(id),
  crop TEXT NOT NULL, cause TEXT NOT NULL, kg INTEGER NOT NULL CHECK(kg > 0),
  value INTEGER NOT NULL CHECK(value >= 0), incident TEXT NOT NULL,
  comuna TEXT NOT NULL, lat REAL, lon REAL, description TEXT NOT NULL,
  photo TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, sender INTEGER NOT NULL REFERENCES users(id),
  recipient INTEGER NOT NULL REFERENCES users(id), lot INTEGER NOT NULL REFERENCES lots(id),
  body TEXT NOT NULL, photo TEXT NOT NULL DEFAULT '', seen INTEGER NOT NULL DEFAULT 0,
  created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reviews (
  order_id TEXT PRIMARY KEY REFERENCES orders(id), stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
  comment TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER REFERENCES users(id), lot INTEGER REFERENCES lots(id),
  PRIMARY KEY(user_id,lot)
);
CREATE TABLE IF NOT EXISTS meetings (
  lot INTEGER NOT NULL REFERENCES lots(id), participant INTEGER NOT NULL REFERENCES users(id),
  room TEXT NOT NULL UNIQUE, PRIMARY KEY(lot,participant)
);
CREATE INDEX IF NOT EXISTS orders_by_lot ON orders(lot);
CREATE INDEX IF NOT EXISTS messages_by_recipient ON messages(recipient,seen);
CREATE INDEX IF NOT EXISTS notices_by_recipient ON notices(recipient,seen);
CREATE TABLE IF NOT EXISTS collaborative (
  id INTEGER PRIMARY KEY, owner INTEGER NOT NULL REFERENCES users(id),
  base_lot INTEGER NOT NULL REFERENCES lots(id), offer INTEGER UNIQUE REFERENCES lots(id),
  target INTEGER NOT NULL CHECK(target>0), deadline TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','offered','cancelled'))
);
CREATE TABLE IF NOT EXISTS contributions (
  group_id INTEGER NOT NULL REFERENCES collaborative(id), lot INTEGER NOT NULL REFERENCES lots(id),
  kg INTEGER NOT NULL CHECK(kg>0), status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
  PRIMARY KEY(group_id,lot)
);
CREATE TABLE IF NOT EXISTS allocations (
  order_id TEXT NOT NULL REFERENCES orders(id), lot INTEGER NOT NULL REFERENCES lots(id),
  kg INTEGER NOT NULL CHECK(kg>0), gross INTEGER NOT NULL, commission INTEGER NOT NULL,
  PRIMARY KEY(order_id,lot)
);
CREATE TABLE IF NOT EXISTS adjustments (
  order_id TEXT PRIMARY KEY REFERENCES orders(id), kg INTEGER NOT NULL CHECK(kg>0),
  reason TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS withdrawn_lots (
  lot INTEGER PRIMARY KEY REFERENCES lots(id), reason TEXT NOT NULL,
  created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS dispatches (
  order_id TEXT PRIMARY KEY REFERENCES orders(id), requester INTEGER NOT NULL REFERENCES users(id),
  cost INTEGER NOT NULL DEFAULT 0, commission INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, note TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, monthly_clp INTEGER NOT NULL CHECK(monthly_clp>=0),
  benefits TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  plan INTEGER NOT NULL REFERENCES plans(id), status TEXT NOT NULL, renews TEXT
);
CREATE TABLE IF NOT EXISTS account_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL DEFAULT '' CHECK(length(phone)<=30),
  lat REAL, lon REAL,
  CHECK ((lat IS NULL AND lon IS NULL) OR
    (lat IS NOT NULL AND lon IS NOT NULL AND lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180))
);
CREATE TABLE IF NOT EXISTS email_preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('publications','orders','reminders','harvest','weather')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  PRIMARY KEY (user_id,category)
);
CREATE TABLE IF NOT EXISTS email_queue (
  id INTEGER PRIMARY KEY,
  recipient INTEGER NOT NULL REFERENCES users(id),
  address TEXT NOT NULL,
  category TEXT NOT NULL,
  body TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  due INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(recipient, event)
);
CREATE INDEX IF NOT EXISTS email_queue_due ON email_queue(status,due);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires);
CREATE INDEX IF NOT EXISTS lots_by_producer ON lots(producer);
CREATE INDEX IF NOT EXISTS lots_by_deadline ON lots(deadline) WHERE available>0;
CREATE INDEX IF NOT EXISTS orders_by_buyer ON orders(buyer);
CREATE INDEX IF NOT EXISTS payments_by_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS users_by_comuna ON users(comuna COLLATE NOCASE,role);
CREATE INDEX IF NOT EXISTS losses_by_producer ON losses(producer);
CREATE TRIGGER IF NOT EXISTS valid_lot_location_on_insert
BEFORE INSERT ON lots WHEN (NEW.lat IS NULL) <> (NEW.lon IS NULL)
  OR NEW.lat NOT BETWEEN -90 AND 90 OR NEW.lon NOT BETWEEN -180 AND 180
BEGIN
  SELECT RAISE(ABORT,'Coordenadas del lote inválidas');
END;
CREATE TRIGGER IF NOT EXISTS valid_lot_location_on_update
BEFORE UPDATE OF lat,lon ON lots WHEN (NEW.lat IS NULL) <> (NEW.lon IS NULL)
  OR NEW.lat NOT BETWEEN -90 AND 90 OR NEW.lon NOT BETWEEN -180 AND 180
BEGIN
  SELECT RAISE(ABORT,'Coordenadas del lote inválidas');
END;
CREATE TRIGGER IF NOT EXISTS valid_loss_location_on_insert
BEFORE INSERT ON losses WHEN (NEW.lat IS NULL) <> (NEW.lon IS NULL)
  OR NEW.lat NOT BETWEEN -90 AND 90 OR NEW.lon NOT BETWEEN -180 AND 180
BEGIN
  SELECT RAISE(ABORT,'Coordenadas de la pérdida inválidas');
END;
CREATE TRIGGER IF NOT EXISTS valid_loss_location_on_update
BEFORE UPDATE OF lat,lon ON losses WHEN (NEW.lat IS NULL) <> (NEW.lon IS NULL)
  OR NEW.lat NOT BETWEEN -90 AND 90 OR NEW.lon NOT BETWEEN -180 AND 180
BEGIN
  SELECT RAISE(ABORT,'Coordenadas de la pérdida inválidas');
END;
COMMIT;
