package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

func requireNonEmpty(name, value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s cannot be empty", name)
	}
	return nil
}

func NewRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "mercury",
		Short: "Inter-agent communication bus",
	}

	root.AddCommand(
		newSendCmd(),
		newReadCmd(),
		newSubscribeCmd(),
		newUnsubscribeCmd(),
		newChannelsCmd(),
		newLogCmd(),
		newRouteCmd(),
	)

	return root
}
