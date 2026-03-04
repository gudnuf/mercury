package cmd

import (
	"fmt"
	"os"
	"time"

	"github.com/gudnuf/mercury/internal/db"
	"github.com/spf13/cobra"
)

func newReadCmd() *cobra.Command {
	var as, channel string
	var follow, verbose bool

	cmd := &cobra.Command{
		Use:   "read",
		Short: "Read unread messages",
		RunE: func(cmd *cobra.Command, args []string) error {
			d, err := db.Open()
			if err != nil {
				return err
			}
			defer d.Close()

			for {
				msgs, err := readMessages(d, as, channel)
				if err != nil {
					return err
				}
				for _, m := range msgs {
					if verbose {
						fmt.Printf("%s [%s] %s: %s\n", m.CreatedAt, m.Channel, m.Sender, m.Body)
					} else {
						fmt.Printf("[%s] %s: %s\n", m.Channel, m.Sender, m.Body)
					}
				}
				if err := updateCursors(d, as, msgs); err != nil {
					return err
				}
				if !follow {
					if len(msgs) == 0 && channel == "" {
						subs, err := d.Subscriptions(as)
						if err != nil {
							return err
						}
						if len(subs) == 0 {
							fmt.Fprintln(os.Stderr, "No subscriptions. Use: mercury subscribe --as "+as+" --channel CHANNEL")
						}
					}
					return nil
				}
				time.Sleep(500 * time.Millisecond)
			}
		},
	}

	cmd.Flags().StringVar(&as, "as", "", "reader agent name (required)")
	cmd.Flags().StringVar(&channel, "channel", "", "specific channel to read")
	cmd.Flags().BoolVar(&follow, "follow", false, "poll for new messages")
	cmd.Flags().BoolVar(&verbose, "verbose", false, "include timestamps")
	cmd.MarkFlagRequired("as")

	return cmd
}

func readMessages(d *db.DB, agent, channel string) ([]db.Message, error) {
	if channel != "" {
		return d.ReadUnreadChannel(agent, channel)
	}
	subs, err := d.Subscriptions(agent)
	if err != nil {
		return nil, err
	}
	return d.ReadUnread(agent, subs)
}

func updateCursors(d *db.DB, agent string, msgs []db.Message) error {
	// Track highest ID per channel
	highest := make(map[string]int64)
	for _, m := range msgs {
		if m.ID > highest[m.Channel] {
			highest[m.Channel] = m.ID
		}
	}
	for ch, id := range highest {
		if err := d.UpdateCursor(agent, ch, id); err != nil {
			return err
		}
	}
	return nil
}
