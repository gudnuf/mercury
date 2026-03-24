package db

import (
	"path/filepath"
	"testing"
)

func openTestDB(t *testing.T) *DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	d, err := OpenPath(path)
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func TestSendAndLog(t *testing.T) {
	d := openTestDB(t)

	if err := d.Send("status", "alice", "hello world"); err != nil {
		t.Fatalf("send: %v", err)
	}

	msgs, err := d.Log("status", 10)
	if err != nil {
		t.Fatalf("log: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	m := msgs[0]
	if m.Channel != "status" {
		t.Fatalf("channel: got %q, want %q", m.Channel, "status")
	}
	if m.Sender != "alice" {
		t.Fatalf("sender: got %q, want %q", m.Sender, "alice")
	}
	if m.Body != "hello world" {
		t.Fatalf("body: got %q, want %q", m.Body, "hello world")
	}
}

func TestSubscribeAndReadUnread(t *testing.T) {
	d := openTestDB(t)

	if err := d.Subscribe("bob", "updates"); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if err := d.Send("updates", "alice", "msg1"); err != nil {
		t.Fatalf("send: %v", err)
	}

	subs, err := d.Subscriptions("bob")
	if err != nil {
		t.Fatalf("subscriptions: %v", err)
	}

	msgs, err := d.ReadUnread("bob", subs)
	if err != nil {
		t.Fatalf("read unread: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Body != "msg1" {
		t.Fatalf("body: got %q, want %q", msgs[0].Body, "msg1")
	}

	// Advance cursor
	if err := d.UpdateCursor("bob", "updates", msgs[0].ID); err != nil {
		t.Fatalf("update cursor: %v", err)
	}

	// Read again — should be empty
	msgs, err = d.ReadUnread("bob", subs)
	if err != nil {
		t.Fatalf("read unread (second): %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages on second read, got %d", len(msgs))
	}
}

func TestReadUnreadNoSubscriptions(t *testing.T) {
	d := openTestDB(t)

	if err := d.Send("updates", "alice", "msg1"); err != nil {
		t.Fatalf("send: %v", err)
	}

	msgs, err := d.ReadUnread("bob", nil)
	if err != nil {
		t.Fatalf("read unread: %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages, got %d", len(msgs))
	}
}

func TestUnsubscribe(t *testing.T) {
	d := openTestDB(t)

	if err := d.Subscribe("bob", "updates"); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if err := d.Unsubscribe("bob", "updates"); err != nil {
		t.Fatalf("unsubscribe: %v", err)
	}

	subs, err := d.Subscriptions("bob")
	if err != nil {
		t.Fatalf("subscriptions: %v", err)
	}
	if len(subs) != 0 {
		t.Fatalf("expected 0 subscriptions after unsubscribe, got %d", len(subs))
	}

	if err := d.Send("updates", "alice", "msg1"); err != nil {
		t.Fatalf("send: %v", err)
	}

	msgs, err := d.ReadUnread("bob", subs)
	if err != nil {
		t.Fatalf("read unread: %v", err)
	}
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages after unsubscribe, got %d", len(msgs))
	}
}

func TestMultipleChannels(t *testing.T) {
	d := openTestDB(t)

	if err := d.Subscribe("bob", "status"); err != nil {
		t.Fatalf("subscribe status: %v", err)
	}
	if err := d.Subscribe("bob", "alerts"); err != nil {
		t.Fatalf("subscribe alerts: %v", err)
	}

	if err := d.Send("status", "alice", "status msg"); err != nil {
		t.Fatalf("send status: %v", err)
	}
	if err := d.Send("alerts", "alice", "alert msg"); err != nil {
		t.Fatalf("send alerts: %v", err)
	}

	subs, err := d.Subscriptions("bob")
	if err != nil {
		t.Fatalf("subscriptions: %v", err)
	}
	if len(subs) != 2 {
		t.Fatalf("expected 2 subscriptions, got %d", len(subs))
	}

	msgs, err := d.ReadUnread("bob", subs)
	if err != nil {
		t.Fatalf("read unread: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}

	bodies := map[string]bool{}
	for _, m := range msgs {
		bodies[m.Body] = true
	}
	if !bodies["status msg"] {
		t.Fatal("missing status msg")
	}
	if !bodies["alert msg"] {
		t.Fatal("missing alert msg")
	}
}

func TestCursorTracking(t *testing.T) {
	d := openTestDB(t)

	if err := d.Subscribe("bob", "ch"); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if err := d.Send("ch", "alice", "msg1"); err != nil {
		t.Fatalf("send msg1: %v", err)
	}

	subs, err := d.Subscriptions("bob")
	if err != nil {
		t.Fatalf("subscriptions: %v", err)
	}

	// First read — gets msg1
	msgs, err := d.ReadUnread("bob", subs)
	if err != nil {
		t.Fatalf("read unread (first): %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Body != "msg1" {
		t.Fatalf("body: got %q, want %q", msgs[0].Body, "msg1")
	}

	// Advance cursor past msg1
	if err := d.UpdateCursor("bob", "ch", msgs[0].ID); err != nil {
		t.Fatalf("update cursor: %v", err)
	}

	// Send msg2
	if err := d.Send("ch", "alice", "msg2"); err != nil {
		t.Fatalf("send msg2: %v", err)
	}

	// Second read — should only get msg2
	msgs, err = d.ReadUnread("bob", subs)
	if err != nil {
		t.Fatalf("read unread (second): %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message on second read, got %d", len(msgs))
	}
	if msgs[0].Body != "msg2" {
		t.Fatalf("body: got %q, want %q", msgs[0].Body, "msg2")
	}
}

func TestChannelsList(t *testing.T) {
	d := openTestDB(t)

	if err := d.Send("alpha", "alice", "a"); err != nil {
		t.Fatalf("send alpha: %v", err)
	}
	if err := d.Send("beta", "alice", "b"); err != nil {
		t.Fatalf("send beta: %v", err)
	}
	if err := d.Send("gamma", "alice", "g"); err != nil {
		t.Fatalf("send gamma: %v", err)
	}

	channels, err := d.Channels()
	if err != nil {
		t.Fatalf("channels: %v", err)
	}
	if len(channels) != 3 {
		t.Fatalf("expected 3 channels, got %d", len(channels))
	}

	// Channels() returns ORDER BY channel, so should be sorted
	expected := []string{"alpha", "beta", "gamma"}
	for i, want := range expected {
		if channels[i] != want {
			t.Fatalf("channels[%d]: got %q, want %q", i, channels[i], want)
		}
	}
}

func TestAddAndListRoutes(t *testing.T) {
	d := openTestDB(t)

	if err := d.AddRoute("status", "discord:123456", "{}"); err != nil {
		t.Fatalf("add route: %v", err)
	}
	if err := d.AddRoute("*", "discord:789012", `{"format":"compact"}`); err != nil {
		t.Fatalf("add wildcard route: %v", err)
	}

	routes, err := d.ListRoutes()
	if err != nil {
		t.Fatalf("list routes: %v", err)
	}
	if len(routes) != 2 {
		t.Fatalf("expected 2 routes, got %d", len(routes))
	}

	// Ordered by channel, destination — "*" sorts before "status"
	if routes[0].Channel != "*" {
		t.Fatalf("routes[0].Channel: got %q, want %q", routes[0].Channel, "*")
	}
	if routes[0].Destination != "discord:789012" {
		t.Fatalf("routes[0].Destination: got %q, want %q", routes[0].Destination, "discord:789012")
	}
	if routes[0].Config != `{"format":"compact"}` {
		t.Fatalf("routes[0].Config: got %q, want %q", routes[0].Config, `{"format":"compact"}`)
	}
	if !routes[0].Active {
		t.Fatal("routes[0] should be active")
	}

	if routes[1].Channel != "status" {
		t.Fatalf("routes[1].Channel: got %q, want %q", routes[1].Channel, "status")
	}
	if routes[1].Destination != "discord:123456" {
		t.Fatalf("routes[1].Destination: got %q, want %q", routes[1].Destination, "discord:123456")
	}
}

func TestAddRouteDuplicate(t *testing.T) {
	d := openTestDB(t)

	if err := d.AddRoute("status", "discord:123", "{}"); err != nil {
		t.Fatalf("add route: %v", err)
	}
	// Adding the same channel+destination again should not error (INSERT OR IGNORE)
	if err := d.AddRoute("status", "discord:123", `{"updated":true}`); err != nil {
		t.Fatalf("add duplicate route: %v", err)
	}

	routes, err := d.ListRoutes()
	if err != nil {
		t.Fatalf("list routes: %v", err)
	}
	if len(routes) != 1 {
		t.Fatalf("expected 1 route after duplicate add, got %d", len(routes))
	}
	// Config should remain the original since INSERT OR IGNORE keeps existing row
	if routes[0].Config != "{}" {
		t.Fatalf("config: got %q, want %q", routes[0].Config, "{}")
	}
}

func TestAddRouteDefaultConfig(t *testing.T) {
	d := openTestDB(t)

	// Empty config should default to "{}"
	if err := d.AddRoute("status", "discord:123", ""); err != nil {
		t.Fatalf("add route: %v", err)
	}

	routes, err := d.ListRoutes()
	if err != nil {
		t.Fatalf("list routes: %v", err)
	}
	if len(routes) != 1 {
		t.Fatalf("expected 1 route, got %d", len(routes))
	}
	if routes[0].Config != "{}" {
		t.Fatalf("config: got %q, want %q", routes[0].Config, "{}")
	}
}

func TestRemoveRoute(t *testing.T) {
	d := openTestDB(t)

	if err := d.AddRoute("status", "discord:123", "{}"); err != nil {
		t.Fatalf("add route: %v", err)
	}

	removed, err := d.RemoveRoute("status", "discord:123")
	if err != nil {
		t.Fatalf("remove route: %v", err)
	}
	if !removed {
		t.Fatal("expected route to be removed")
	}

	routes, err := d.ListRoutes()
	if err != nil {
		t.Fatalf("list routes: %v", err)
	}
	if len(routes) != 0 {
		t.Fatalf("expected 0 routes after removal, got %d", len(routes))
	}
}

func TestRemoveRouteNotFound(t *testing.T) {
	d := openTestDB(t)

	removed, err := d.RemoveRoute("nonexistent", "discord:123")
	if err != nil {
		t.Fatalf("remove route: %v", err)
	}
	if removed {
		t.Fatal("expected no route to be removed")
	}
}

func TestRoutesByChannel(t *testing.T) {
	d := openTestDB(t)

	if err := d.AddRoute("status", "discord:111", "{}"); err != nil {
		t.Fatalf("add route: %v", err)
	}
	if err := d.AddRoute("alerts", "discord:222", "{}"); err != nil {
		t.Fatalf("add route: %v", err)
	}
	if err := d.AddRoute("*", "discord:333", "{}"); err != nil {
		t.Fatalf("add wildcard route: %v", err)
	}

	// Query for "status" should return the specific route + wildcard
	routes, err := d.RoutesByChannel("status")
	if err != nil {
		t.Fatalf("routes by channel: %v", err)
	}
	if len(routes) != 2 {
		t.Fatalf("expected 2 routes for 'status', got %d", len(routes))
	}

	dests := map[string]bool{}
	for _, r := range routes {
		dests[r.Destination] = true
	}
	if !dests["discord:111"] {
		t.Fatal("missing discord:111 route")
	}
	if !dests["discord:333"] {
		t.Fatal("missing discord:333 wildcard route")
	}

	// Query for "alerts" should return the specific route + wildcard
	routes, err = d.RoutesByChannel("alerts")
	if err != nil {
		t.Fatalf("routes by channel: %v", err)
	}
	if len(routes) != 2 {
		t.Fatalf("expected 2 routes for 'alerts', got %d", len(routes))
	}

	// Query for "other" should return only wildcard
	routes, err = d.RoutesByChannel("other")
	if err != nil {
		t.Fatalf("routes by channel: %v", err)
	}
	if len(routes) != 1 {
		t.Fatalf("expected 1 route for 'other', got %d", len(routes))
	}
	if routes[0].Destination != "discord:333" {
		t.Fatalf("expected wildcard route, got %q", routes[0].Destination)
	}
}

func TestListRoutesEmpty(t *testing.T) {
	d := openTestDB(t)

	routes, err := d.ListRoutes()
	if err != nil {
		t.Fatalf("list routes: %v", err)
	}
	if routes != nil {
		t.Fatalf("expected nil routes, got %d", len(routes))
	}
}
