CREATE TABLE checkpoints (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL);
CREATE TABLE scans (workflow TEXT NOT NULL, key TEXT NOT NULL, checked_at INTEGER NOT NULL, successful_at INTEGER NOT NULL, PRIMARY KEY (workflow, key));
CREATE TABLE controls (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT, configuration_revision TEXT NOT NULL DEFAULT '', delivery_enabled INTEGER NOT NULL DEFAULT 0, configured_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO controls (id) VALUES (1);
