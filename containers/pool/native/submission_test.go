package nativeapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/httptransport"
)

func TestTypeSafeSubmissionAuxiliaryHTTPDoesNotSubmitGeneration(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, errRead := io.Copy(io.Discard, r.Body); errRead != nil {
			t.Error(errRead)
			return
		}
		if _, errWrite := io.WriteString(w, `{"detail":"auxiliary accepted"}`); errWrite != nil {
			t.Error(errWrite)
		}
	}))
	t.Cleanup(upstream.Close)
	target, errURL := url.Parse(upstream.URL)
	if errURL != nil {
		t.Fatal(errURL)
	}
	ctx := httptransport.WithSubmissionTracking(context.Background())
	ctx = context.WithValue(ctx, "cliproxy.roundtripper", nativeTestTransport{target})
	request, errRequest := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.typesafe.ai/v1/systemone", strings.NewReader(`{}`))
	if errRequest != nil {
		t.Fatal(errRequest)
	}
	account := &auth.Auth{ID: "auxiliary-native", Metadata: map[string]any{"token": "synthetic-native"}}
	native := &executor{cfg: &config.Config{}}
	response, errSend := native.HttpRequest(ctx, account, request)
	if errSend != nil {
		t.Fatal(errSend)
	}
	body, errRead := io.ReadAll(response.Body)
	errClose := response.Body.Close()
	if errRead != nil || errClose != nil {
		t.Fatalf("read=%v close=%v", errRead, errClose)
	}
	if response.StatusCode != http.StatusOK || string(body) != `{"detail":"auxiliary accepted"}` {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	local := errors.New("later generation preparation failed")
	if classified := httptransport.ClassifySubmissionError(ctx, local); classified != local {
		t.Fatalf("auxiliary HTTP made a later generation ambiguous: %v", classified)
	}
}
