-- Telegram Task Bot schema
-- One row per Telegram chat (group, supergroup, or private DM)
CREATE TABLE IF NOT EXISTS chats (
  chat_id       INTEGER PRIMARY KEY,
  chat_type     TEXT,
  chat_title    TEXT,
  header        TEXT DEFAULT '',
  footer        TEXT DEFAULT '',
  task_counter  INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Tasks, scoped by chat_id. task_number is per-chat (1, 2, 3, ...)
-- so "task 1 done" always means task #1 *in that chat*.
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  task_number   INTEGER NOT NULL,
  description   TEXT NOT NULL,
  status        TEXT DEFAULT 'pending', -- 'pending' | 'done'
  created_by    TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  done_by       TEXT,
  done_at       TEXT,
  FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks(chat_id);
CREATE INDEX IF NOT EXISTS idx_tasks_chat_number ON tasks(chat_id, task_number);

-- ===== Reading Plan feature =====
-- A rotating multi-day reading roster. Only the most recent row per
-- chat_id with status='active' is the "current" plan; older ones are
-- kept as history with status='archived' or 'finished'.
CREATE TABLE IF NOT EXISTS reading_plans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         INTEGER NOT NULL,
  title           TEXT NOT NULL,
  total_days      INTEGER NOT NULL,
  total_chapters  INTEGER NOT NULL,
  increment       INTEGER NOT NULL DEFAULT 1,
  footer          TEXT DEFAULT 'Read the Chapter before the end of the working day.',
  current_day     INTEGER NOT NULL DEFAULT 0, -- 0 = not started yet
  last_chapter    INTEGER NOT NULL DEFAULT 0, -- running chapter pointer (keeps counting past wraps)
  status          TEXT NOT NULL DEFAULT 'active', -- active | finished | archived
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reading_plans_chat_status ON reading_plans(chat_id, status);

-- Readers in a chat's rotation, in a fixed order (position 0, 1, 2...).
-- These are just labels ("User1", "@alice", etc.) — no Telegram
-- user_id resolution needed.
CREATE TABLE IF NOT EXISTS readers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  added_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_readers_chat ON readers(chat_id);

-- One row per generated day of a plan. message_id is the Telegram
-- message that gets edited in place as chapters are checked off.
CREATE TABLE IF NOT EXISTS reading_days (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  plan_id       INTEGER NOT NULL,
  day_number    INTEGER NOT NULL,
  day_date      TEXT NOT NULL,   -- e.g. "01 MARCH 2026"
  message_id    INTEGER,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (plan_id) REFERENCES reading_plans(id)
);
CREATE INDEX IF NOT EXISTS idx_reading_days_chat ON reading_days(chat_id);
CREATE INDEX IF NOT EXISTS idx_reading_days_plan ON reading_days(plan_id);

-- Individual chapter assignments within a single day.
CREATE TABLE IF NOT EXISTS reading_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id            INTEGER NOT NULL,
  item_number       INTEGER NOT NULL, -- 1-based position in that day's list
  chapter_number    INTEGER NOT NULL,
  reader_name       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | done
  done_by           TEXT,
  done_at           TEXT,
  FOREIGN KEY (day_id) REFERENCES reading_days(id)
);
CREATE INDEX IF NOT EXISTS idx_reading_items_day ON reading_items(day_id);