package cmd

import (
	"fmt"

	"github.com/gudnuf/mercury/internal/db"
	"github.com/spf13/cobra"
)

func newRouteCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "route",
		Short: "Manage transport routes",
	}

	cmd.AddCommand(
		newRouteListCmd(),
		newRouteAddCmd(),
		newRouteRemoveCmd(),
	)

	return cmd
}

func newRouteListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List all routes",
		RunE: func(cmd *cobra.Command, args []string) error {
			d, err := db.Open()
			if err != nil {
				return err
			}
			defer d.Close()

			routes, err := d.ListRoutes()
			if err != nil {
				return err
			}
			if len(routes) == 0 {
				fmt.Println("No routes configured.")
				return nil
			}
			for _, r := range routes {
				status := "active"
				if !r.Active {
					status = "inactive"
				}
				fmt.Printf("%-12s -> %-30s [%s] config=%s\n", r.Channel, r.Destination, status, r.Config)
			}
			return nil
		},
	}
}

func newRouteAddCmd() *cobra.Command {
	var channel, to, config string

	cmd := &cobra.Command{
		Use:   "add",
		Short: "Add a route from a channel to a destination",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := requireNonEmpty("--channel", channel); err != nil {
				return err
			}
			if err := requireNonEmpty("--to", to); err != nil {
				return err
			}

			d, err := db.Open()
			if err != nil {
				return err
			}
			defer d.Close()

			if err := d.AddRoute(channel, to, config); err != nil {
				return err
			}
			fmt.Printf("Route added: %s -> %s\n", channel, to)
			return nil
		},
	}

	cmd.Flags().StringVar(&channel, "channel", "", "channel to watch (required, use \"*\" for all)")
	cmd.Flags().StringVar(&to, "to", "", "transport destination (required, e.g. \"discord:1234567890\")")
	cmd.Flags().StringVar(&config, "config", "{}", "JSON config for the route")
	cmd.MarkFlagRequired("channel")
	cmd.MarkFlagRequired("to")

	return cmd
}

func newRouteRemoveCmd() *cobra.Command {
	var channel, to string

	cmd := &cobra.Command{
		Use:   "remove",
		Short: "Remove a route",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := requireNonEmpty("--channel", channel); err != nil {
				return err
			}
			if err := requireNonEmpty("--to", to); err != nil {
				return err
			}

			d, err := db.Open()
			if err != nil {
				return err
			}
			defer d.Close()

			removed, err := d.RemoveRoute(channel, to)
			if err != nil {
				return err
			}
			if !removed {
				return fmt.Errorf("no route found: %s -> %s", channel, to)
			}
			fmt.Printf("Route removed: %s -> %s\n", channel, to)
			return nil
		},
	}

	cmd.Flags().StringVar(&channel, "channel", "", "channel (required)")
	cmd.Flags().StringVar(&to, "to", "", "destination (required)")
	cmd.MarkFlagRequired("channel")
	cmd.MarkFlagRequired("to")

	return cmd
}
