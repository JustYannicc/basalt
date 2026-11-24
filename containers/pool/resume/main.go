// Command pool-resume is the pool container's resumable-stream front layer (#1642).
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"
)

const (
	listenAddress   = ":8316"
	upstreamAddress = "http://127.0.0.1:8317"
	// Soft runtime ceiling for the whole process. Buffers get their own hard, counted budget.
	memoryLimitBytes = 192 << 20
	// Well inside the supervisor's child stop grace (CHILD_STOP_GRACE_SECONDS in supervisor.py), so
	// the layer finishes draining and exits before it is killed.
	drainGrace = 14 * time.Second
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "pool-resume:", err)
		os.Exit(1)
	}
}

func run() error {
	debug.SetMemoryLimit(memoryLimitBytes)
	upstream, err := url.Parse(upstreamAddress)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		return err
	}
	server := &http.Server{
		Handler:           NewLayer(upstream, NewStore(productionLimits()), os.Getenv("POOL_BOOT_ID")),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	select {
	case err := <-served:
		return err
	case <-stop:
		// Stop accepting and let calls in flight finish inside the supervisor's stop grace.
		ctx, cancel := context.WithTimeout(context.Background(), drainGrace)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		if err := server.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}
