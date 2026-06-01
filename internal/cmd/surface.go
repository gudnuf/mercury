package cmd

import (
	"fmt"

	"github.com/gudnuf/mercury/internal/db"
	"github.com/spf13/cobra"
)

func newSurfaceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "surface",
		Short: "Manage channel-to-surface registrations",
	}

	cmd.AddCommand(
		newSurfaceListCmd(),
		newSurfaceAddCmd(),
		newSurfaceRemoveCmd(),
	)

	return cmd
}

func newSurfaceListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List all surfaces",
		RunE: func(cmd *cobra.Command, args []string) error {
			d, err := db.Open()
			if err != nil {
				return err
			}
			defer d.Close()

			surfaces, err := d.ListSurfaces()
			if err != nil {
				return err
			}
			if len(surfaces) == 0 {
				fmt.Println("No surfaces configured.")
				return nil
			}
			for _, s := range surfaces {
				fmt.Printf("%-24s kind=%-10s address=%-30s parent=%-24s name=%s\n",
					s.MercuryChannel, s.Kind, s.Address, s.ParentChannel, s.Name)
			}
			return nil
		},
	}
}

func newSurfaceAddCmd() *cobra.Command {
	var channel, kind, address, parent, name string

	cmd := &cobra.Command{
		Use:   "add",
		Short: "Register a Mercury channel against an external surface",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := requireNonEmpty("--channel", channel); err != nil {
				return err
			}
			if err := requireNonEmpty("--kind", kind); err != nil {
				return err
			}
			if err := requireNonEmpty("--address", address); err != nil {
				return err
			}

			d, err := db.Open()
			if err != nil {
				return err
			}
			defer d.Close()

			if err := d.AddSurface(channel, kind, address, parent, name); err != nil {
				return err
			}
			fmt.Printf("Surface added: %s -> %s:%s\n", channel, kind, address)
			return nil
		},
	}

	cmd.Flags().StringVar(&channel, "channel", "", "mercury channel (required)")
	cmd.Flags().StringVar(&kind, "kind", "", "consumer-defined surface kind (required, opaque to Mercury)")
	cmd.Flags().StringVar(&address, "address", "", "consumer-defined surface address (required, opaque to Mercury)")
	cmd.Flags().StringVar(&parent, "parent", "", "parent mercury channel (optional)")
	cmd.Flags().StringVar(&name, "name", "", "human label (optional)")
	cmd.MarkFlagRequired("channel")
	cmd.MarkFlagRequired("kind")
	cmd.MarkFlagRequired("address")

	return cmd
}

func newSurfaceRemoveCmd() *cobra.Command {
	var channel string

	cmd := &cobra.Command{
		Use:   "remove",
		Short: "Remove a surface registration",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := requireNonEmpty("--channel", channel); err != nil {
				return err
			}

			d, err := db.Open()
			if err != nil {
				return err
			}
			defer d.Close()

			removed, err := d.RemoveSurface(channel)
			if err != nil {
				return err
			}
			if !removed {
				return fmt.Errorf("no surface found: %s", channel)
			}
			fmt.Printf("Surface removed: %s\n", channel)
			return nil
		},
	}

	cmd.Flags().StringVar(&channel, "channel", "", "mercury channel (required)")
	cmd.MarkFlagRequired("channel")

	return cmd
}
