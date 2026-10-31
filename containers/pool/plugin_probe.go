// Build-time proof of the pinned plugin's native ABI and provider registration.
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginhost"
)

func main() {
	if len(os.Args) != 2 {
		panic("usage: plugin-probe <plugin-directory>")
	}
	host := pluginhost.New()
	defer host.ShutdownAll()
	enabled := true
	host.ApplyConfig(context.Background(), pluginhost.RuntimeConfig{
		Enabled: true,
		Dir:     os.Args[1],
		Configs: map[string]pluginhost.PluginInstanceConfig{"gemini-cli": {Enabled: &enabled}, "typesafe": {Enabled: &enabled}},
	})
	if !host.HasAuthProvider("gemini-cli") {
		panic("Gemini CLI plugin did not register its auth provider")
	}
	// The official plugin advertises OAuth-bound models, not a static catalog.
	auth, handled, err := host.ParseAuth(context.Background(), pluginapi.AuthParseRequest{
		Provider: "gemini-cli",
		FileName: "build-probe.json",
		RawJSON:  []byte(`{"type":"gemini-cli","project_id":"build-probe","access_token":"synthetic-build-token","expiry":"2099-01-01T00:00:00Z"}`),
	})
	if err != nil || !handled || auth == nil {
		panic("Gemini CLI plugin did not parse its credential format")
	}
	models := host.ModelsForAuth(context.Background(), auth)
	if models.Err != nil || !models.Handled || len(models.Models) == 0 {
		panic("Gemini CLI plugin did not expose auth-bound models")
	}
	if !host.HasAuthProvider("typesafe") {
		panic("TypeSafe plugin did not register")
	}
	nativeAuth, nativeHandled, nativeErr := host.ParseAuth(context.Background(), pluginapi.AuthParseRequest{
		Provider: "typesafe", FileName: "typesafe-build-probe.json", RawJSON: []byte(`{"type":"typesafe","token":"synthetic-typesafe-build-token"}`),
	})
	if nativeErr != nil || !nativeHandled || nativeAuth == nil {
		panic("TypeSafe plugin did not parse its native credential")
	}
	fmt.Println("Gemini CLI and TypeSafe native plugins registered")
}
