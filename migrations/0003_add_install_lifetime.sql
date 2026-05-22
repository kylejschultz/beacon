CREATE TABLE IF NOT EXISTS install_lifetime (
  project     TEXT NOT NULL,
  install_id  TEXT NOT NULL,
  first_seen  TEXT NOT NULL,
  PRIMARY KEY (project, install_id)
);

INSERT OR IGNORE INTO install_lifetime (project, install_id, first_seen)
SELECT project, install_id, first_seen FROM installs WHERE first_seen IS NOT NULL;
