package nativeapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

type nativeTestTransport struct{ target *url.URL }

func (n nativeTestTransport) RoundTripperFor(*auth.Auth) http.RoundTripper { return n }
func (n nativeTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	forwarded := request.Clone(request.Context())
	target := *request.URL
	target.Scheme, target.Host = n.target.Scheme, n.target.Host
	forwarded.URL = &target
	return http.DefaultTransport.RoundTrip(forwarded)
}

func TestTypeSafeSubmissionPreservesNativeErrors(t *testing.T) {
	for _, path := range []string{"/v1/systemone", "/typesafe/v1/systemone"} {
		for _, disconnect := range []bool{true, false} {
			name := path + "/refusal"
			if disconnect {
				name = path + "/disconnect"
			}
			t.Run(name, func(t *testing.T) {
				var submissions atomic.Int32
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if _, errRead := io.Copy(io.Discard, r.Body); errRead != nil {
						t.Error(errRead)
						return
					}
					submissions.Add(1)
					if disconnect {
						conn, _, errHijack := w.(http.Hijacker).Hijack()
						if errHijack != nil {
							t.Error(errHijack)
							return
						}
						if errClose := conn.Close(); errClose != nil {
							t.Error(errClose)
						}
						return
					}
					w.Header().Set("Retry-After", "7")
					w.WriteHeader(http.StatusTooManyRequests)
					if _, errWrite := io.WriteString(w, `{"detail":"native-typesafe-429"}`); errWrite != nil {
						t.Error(errWrite)
					}
				}))
				t.Cleanup(upstream.Close)
				target, errURL := url.Parse(upstream.URL)
				if errURL != nil {
					t.Fatal(errURL)
				}
				manager := auth.NewManager(nil, &auth.FillFirstSelector{}, nil)
				manager.SetRoundTripperProvider(nativeTestTransport{target})
				manager.RegisterExecutor(&executor{cfg: &config.Config{}})
				model := "native-" + strings.ReplaceAll(t.Name(), "/", "-")
				for _, suffix := range []string{"a", "b"} {
					account := &auth.Auth{ID: model + suffix, Provider: Provider, Status: auth.StatusActive,
						Metadata: map[string]any{"token": "synthetic-native-" + suffix}}
					if _, errRegister := manager.Register(context.Background(), account); errRegister != nil {
						t.Fatal(errRegister)
					}
					registry.GetGlobalRegistry().RegisterClient(account.ID, Provider, []*registry.ModelInfo{{ID: model}})
					t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(account.ID) })
				}
				handler := &handler{BaseAPIHandler: handlers.NewBaseAPIHandlers(&config.SDKConfig{}, manager)}
				router := gin.New()
				router.POST(path, handler.systemOne)
				request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"model":"`+model+`","state":"synthetic","questions":{}}`))
				request.Header.Set("Content-Type", "application/json")
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				wantStatus, wantBody := http.StatusTooManyRequests, `{"detail":"native-typesafe-429"}`
				if disconnect {
					wantStatus, wantBody = http.StatusBadGateway, `{"detail":"TypeSafe request outcome is unknown"}`
				}
				if response.Code != wantStatus || response.Body.String() != wantBody {
					t.Errorf("status=%d body=%s, want %d %s", response.Code, response.Body.String(), wantStatus, wantBody)
				}
				if got := submissions.Load(); got != 1 {
					t.Errorf("upstream submissions=%d, want 1 with two eligible accounts", got)
				}
				if disconnect && response.Header().Get("x-should-retry") != "false" {
					t.Errorf("unknown outcome permits retry: %v", response.Header())
				}
				if !disconnect && response.Header().Get("Retry-After") != "7" {
					t.Errorf("native refusal lost Retry-After: %v", response.Header())
				}
			})
		}
	}
}
