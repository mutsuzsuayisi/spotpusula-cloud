CREATE TABLE IF NOT EXISTS wallet (
  id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL,
  token TEXT NOT NULL,
  body TEXT NOT NULL
);
INSERT OR IGNORE INTO wallet VALUES(1,0,'initial','{"cash":200,"positions":[],"realized":0,"paused":true,"last_check":null,"last_analysis":null,"health":"Kurulum doğrulaması bekleniyor"}');
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  created TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_created ON events(created);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  created TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_created ON reports(created);
