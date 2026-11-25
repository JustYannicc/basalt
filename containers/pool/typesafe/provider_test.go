package main

import (
	"context"
	"net/http"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

type recordingClient struct{ calls []string }

func (c *recordingClient) Do(_ context.Context, req pluginapi.HTTPRequest) (pluginapi.HTTPResponse, error) {
	c.calls = append(c.calls, req.URL)
	return pluginapi.HTTPResponse{StatusCode: http.StatusOK, Body: []byte(`{"models":[{"name":"jev-live","release_date":"2026-10-14"}]}`)}, nil
}

func (c *recordingClient) DoStream(context.Context, pluginapi.HTTPRequest) (pluginapi.HTTPStreamResponse, error) {
	return pluginapi.HTTPStreamResponse{}, nil
}

func TestRoutedCredentialDiscoveryNeverDials(t *testing.T) {
	for name, req := range map[string]pluginapi.AuthModelRequest{
		"storage":  {StorageJSON: []byte(`{"type":"typesafe","token":"synthetic","proxy_url":"socks5://rt_aaaaaaaaaaaaaaaaaaaaaaaaaa:x@127.0.0.1:20990"}`)},
		"metadata": {StorageJSON: []byte(`{"type":"typesafe","token":"synthetic"}`), Metadata: map[string]any{"proxy_url": "socks5://rt_aaaaaaaaaaaaaaaaaaaaaaaaaa:x@127.0.0.1:20990"}},
	} {
		client := &recordingClient{}
		req.HTTPClient = client
		models, err := modelsForAuth(context.Background(), req)
		if err != nil || len(models.Models) == 0 {
			t.Fatalf("%s: models %v, error %v", name, models.Models, err)
		}
		if len(client.calls) != 0 {
			t.Fatalf("%s: a routed credential's discovery dialled %v", name, client.calls)
		}
	}
}

func TestUnroutedCredentialKeepsLiveDiscovery(t *testing.T) {
	client := &recordingClient{}
	models, err := modelsForAuth(context.Background(), pluginapi.AuthModelRequest{
		StorageJSON: []byte(`{"type":"typesafe","token":"synthetic"}`),
		HTTPClient:  client,
	})
	if err != nil || len(client.calls) != 1 || models.Models[0].ID != "jev-live" {
		t.Fatalf("calls %v, models %v, error %v", client.calls, models.Models, err)
	}
}
