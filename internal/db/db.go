package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (agent, channel)
);

CREATE TABLE IF NOT EXISTS cursors (
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent, channel)
);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  destination TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(channel, destination)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_routes_channel ON routes(channel);
`

type DB struct {
	conn *sql.DB
}

type Message struct {
	ID        int64
	Channel   string
	Sender    string
	Body      string
	CreatedAt string
}

type Route struct {
	ID          int64
	Channel     string
	Destination string
	Config      string
	Active      bool
	CreatedAt   string
}

func dbPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".local", "share", "mercury")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return filepath.Join(dir, "mercury.db"), nil
}

func Open() (*DB, error) {
	path, err := dbPath()
	if err != nil {
		return nil, fmt.Errorf("db path: %w", err)
	}
	return OpenPath(path)
}

func OpenPath(path string) (*DB, error) {
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	if _, err := conn.Exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;"); err != nil {
		conn.Close()
		return nil, fmt.Errorf("set pragmas: %w", err)
	}
	if _, err := conn.Exec(schema); err != nil {
		conn.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &DB{conn: conn}, nil
}

func (d *DB) Close() error {
	return d.conn.Close()
}

func (d *DB) Send(channel, sender, body string) error {
	_, err := d.conn.Exec(
		"INSERT INTO messages (channel, sender, body) VALUES (?, ?, ?)",
		channel, sender, body,
	)
	return err
}

func (d *DB) Subscribe(agent, channel string) error {
	_, err := d.conn.Exec(
		"INSERT OR IGNORE INTO subscriptions (agent, channel) VALUES (?, ?)",
		agent, channel,
	)
	return err
}

func (d *DB) Unsubscribe(agent, channel string) error {
	_, err := d.conn.Exec(
		"DELETE FROM subscriptions WHERE agent = ? AND channel = ?",
		agent, channel,
	)
	return err
}

func (d *DB) Subscriptions(agent string) ([]string, error) {
	rows, err := d.conn.Query(
		"SELECT channel FROM subscriptions WHERE agent = ?", agent,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var channels []string
	for rows.Next() {
		var ch string
		if err := rows.Scan(&ch); err != nil {
			return nil, err
		}
		channels = append(channels, ch)
	}
	return channels, rows.Err()
}

func (d *DB) Channels() ([]string, error) {
	rows, err := d.conn.Query("SELECT DISTINCT channel FROM messages ORDER BY channel")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var channels []string
	for rows.Next() {
		var ch string
		if err := rows.Scan(&ch); err != nil {
			return nil, err
		}
		channels = append(channels, ch)
	}
	return channels, rows.Err()
}

func (d *DB) ReadUnread(agent string, channels []string) ([]Message, error) {
	if len(channels) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(channels))
	args := make([]interface{}, 0, len(channels)+1)
	for i, ch := range channels {
		placeholders[i] = "?"
		args = append(args, ch)
	}
	args = append(args, agent)

	query := fmt.Sprintf(`
		SELECT m.id, m.channel, m.sender, m.body, m.created_at
		FROM messages m
		WHERE m.channel IN (%s)
		AND m.id > COALESCE(
			(SELECT last_read_id FROM cursors WHERE agent = ? AND channel = m.channel), 0
		)
		ORDER BY m.id`,
		strings.Join(placeholders, ","),
	)

	rows, err := d.conn.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows)
}

func (d *DB) ReadUnreadChannel(agent, channel string) ([]Message, error) {
	rows, err := d.conn.Query(`
		SELECT m.id, m.channel, m.sender, m.body, m.created_at
		FROM messages m
		WHERE m.channel = ?
		AND m.id > COALESCE(
			(SELECT last_read_id FROM cursors WHERE agent = ? AND channel = ?), 0
		)
		ORDER BY m.id`,
		channel, agent, channel,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows)
}

func (d *DB) UpdateCursor(agent, channel string, lastID int64) error {
	_, err := d.conn.Exec(`
		INSERT INTO cursors (agent, channel, last_read_id) VALUES (?, ?, ?)
		ON CONFLICT(agent, channel) DO UPDATE SET last_read_id = excluded.last_read_id`,
		agent, channel, lastID,
	)
	return err
}

func (d *DB) Log(channel string, limit int) ([]Message, error) {
	var rows *sql.Rows
	var err error
	if channel != "" {
		rows, err = d.conn.Query(
			"SELECT id, channel, sender, body, created_at FROM messages WHERE channel = ? ORDER BY id DESC LIMIT ?",
			channel, limit,
		)
	} else {
		rows, err = d.conn.Query(
			"SELECT id, channel, sender, body, created_at FROM messages ORDER BY id DESC LIMIT ?",
			limit,
		)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	msgs, err := scanMessages(rows)
	if err != nil {
		return nil, err
	}
	// Reverse so oldest first
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, nil
}

func scanMessages(rows *sql.Rows) ([]Message, error) {
	var msgs []Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.Channel, &m.Sender, &m.Body, &m.CreatedAt); err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}

func (d *DB) AddRoute(channel, destination, config string) error {
	if config == "" {
		config = "{}"
	}
	_, err := d.conn.Exec(
		"INSERT OR IGNORE INTO routes (channel, destination, config) VALUES (?, ?, ?)",
		channel, destination, config,
	)
	return err
}

func (d *DB) RemoveRoute(channel, destination string) (bool, error) {
	res, err := d.conn.Exec(
		"DELETE FROM routes WHERE channel = ? AND destination = ?",
		channel, destination,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func (d *DB) ListRoutes() ([]Route, error) {
	rows, err := d.conn.Query(
		"SELECT id, channel, destination, config, active, created_at FROM routes ORDER BY channel, destination",
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRoutes(rows)
}

func (d *DB) RoutesByChannel(channel string) ([]Route, error) {
	rows, err := d.conn.Query(
		`SELECT id, channel, destination, config, active, created_at FROM routes
		 WHERE active = 1 AND (channel = ? OR channel = '*')
		 ORDER BY channel, destination`,
		channel,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRoutes(rows)
}

func scanRoutes(rows *sql.Rows) ([]Route, error) {
	var routes []Route
	for rows.Next() {
		var r Route
		if err := rows.Scan(&r.ID, &r.Channel, &r.Destination, &r.Config, &r.Active, &r.CreatedAt); err != nil {
			return nil, err
		}
		routes = append(routes, r)
	}
	return routes, rows.Err()
}
