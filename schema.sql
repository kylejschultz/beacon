CREATE TABLE IF NOT EXISTS installs (
  project    TEXT NOT NULL,
  install_id TEXT NOT NULL,
  version    TEXT NOT NULL,
  arch       TEXT NOT NULL,
  last_seen  TEXT NOT NULL,  -- ISO 8601 UTC
  PRIMARY KEY (project, install_id)
);
