-- Local SQLite reference schema. The Lingzhu workflow writes the same fields
-- through structured "新增数据 / 更新数据 / 查询数据" nodes, not through SQL.
CREATE TABLE IF NOT EXISTS rhythm_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT,
  bstudio_create_time TEXT,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rhythm_score (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT,
  bstudio_create_time TEXT,
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  song_id TEXT NOT NULL,
  song_title TEXT NOT NULL,
  chart_version INTEGER NOT NULL,
  score INTEGER NOT NULL,
  accuracy INTEGER NOT NULL,
  max_combo INTEGER NOT NULL,
  perfect INTEGER NOT NULL,
  good INTEGER NOT NULL,
  miss INTEGER NOT NULL,
  played_at INTEGER NOT NULL,
  score_basis TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS rhythm_score_song
  ON rhythm_score (song_id, chart_version, score DESC, played_at ASC);
