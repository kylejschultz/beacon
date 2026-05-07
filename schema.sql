CREATE TABLE IF NOT EXISTS installs (
  project    TEXT NOT NULL,
  install_id TEXT NOT NULL,
  version    TEXT NOT NULL,
  arch       TEXT NOT NULL,
  last_seen  TEXT NOT NULL,  -- ISO 8601 UTC
  PRIMARY KEY (project, install_id)
);

CREATE TABLE IF NOT EXISTS install_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project       TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,  -- YYYY-MM-DD UTC-7 (America/Los_Angeles)
  count         INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_history_project_date
  ON install_history (project, snapshot_date);

ALTER TABLE installs ADD COLUMN first_seen TEXT;
UPDATE installs SET first_seen = last_seen WHERE first_seen IS NULL;
