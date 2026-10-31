package nativeapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	coreexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

const upstream = "https://api.typesafe.ai/v1"

type executor struct{ cfg *config.Config }

func (e *executor) Identifier() string { return Provider }

func (e *executor) Execute(ctx context.Context, account *auth.Auth, req coreexecutor.Request, opts coreexecutor.Options) (result coreexecutor.Response, failed error) {
	reporter := helps.NewExecutorUsageReporter(ctx, e, req.Model, account)
	defer reporter.TrackFailure(ctx, &failed)
	if opts.SourceFormat.String() != Protocol {
		return result, terminal(415, []byte(`{"detail":"This model requires typesafe-systemone at /v1/systemone"}`), nil)
	}
	body, contentType, encoding, errPrepare := e.prepare(req, opts)
	if errPrepare != nil {
		return result, terminal(400, []byte(`{"detail":"Invalid TypeSafe payload"}`), nil)
	}
	outgoing, errNew := http.NewRequestWithContext(ctx, http.MethodPost, upstream+"/systemone", bytes.NewReader(body))
	if errNew != nil {
		return result, errNew
	}
	outgoing.Header.Set("Content-Type", contentType)
	if encoding != "" {
		outgoing.Header.Set("Content-Encoding", encoding)
	}
	outgoing.Header.Set("Accept", "application/json")
	for name, values := range opts.Headers {
		if strings.HasPrefix(strings.ToLower(name), "typesafe-danger-zone-") {
			outgoing.Header[name] = append([]string(nil), values...)
		}
	}
	reporter.StartResponseTTFT()
	response, errSend := e.HttpRequest(ctx, account, outgoing)
	if errSend != nil {
		// An uncertain send must return to the caller before its SDK decides whether to retry.
		return result, terminal(502, []byte(`{"detail":"TypeSafe request outcome is unknown"}`), nil)
	}
	defer response.Body.Close()
	payload, errRead := io.ReadAll(io.LimitReader(response.Body, maxBody+1))
	if errRead != nil || len(payload) > maxBody {
		return result, terminal(502, []byte(`{"detail":"Invalid TypeSafe response"}`), nil)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return result, terminal(response.StatusCode, payload, response.Header)
	}
	reporter.RecordFirstPacket()
	reporter.Publish(ctx, helps.ParseOpenAIUsage(payload))
	reporter.EnsurePublished(ctx)
	return coreexecutor.Response{Payload: payload, Headers: response.Header}, nil
}

func (e *executor) prepare(req coreexecutor.Request, opts coreexecutor.Options) ([]byte, string, string, error) {
	decoded, err := decodeBody(req.Payload, opts.Headers)
	if err != nil {
		return nil, "", "", err
	}
	original, err := requestJSON(decoded, opts.Headers.Get("Content-Type"))
	if err != nil {
		return nil, "", "", err
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(original, &envelope); err != nil {
		return nil, "", "", err
	}
	var requested string
	if err := json.Unmarshal(envelope["model"], &requested); err != nil {
		return nil, "", "", err
	}
	current := original
	if requested != req.Model {
		envelope["model"], _ = json.Marshal(req.Model)
		current, err = json.Marshal(envelope)
		if err != nil {
			return nil, "", "", err
		}
	}
	finalReq, finalOpts := req, opts
	finalReq.Payload, finalOpts.OriginalRequest = original, original
	// User payload rules are the final semantic mutation, including native multipart requests.
	current = helps.NewPayloadFinalizer(e.cfg, Provider, req.Model, Protocol, "", original, finalReq, finalOpts)(current)
	if bytes.Equal(current, original) {
		return req.Payload, opts.Headers.Get("Content-Type"), opts.Headers.Get("Content-Encoding"), nil
	}
	body, contentType, err := replaceJSON(decoded, opts.Headers.Get("Content-Type"), current)
	if err != nil {
		return nil, "", "", err
	}
	if len(body) > maxBody {
		return nil, "", "", fmt.Errorf("Configured body exceeds 32 MiB")
	}
	return body, contentType, "", nil
}

func (e *executor) HttpRequest(ctx context.Context, account *auth.Auth, request *http.Request) (*http.Response, error) {
	if request == nil || request.URL.Scheme != "https" || request.URL.Host != "api.typesafe.ai" || !strings.HasPrefix(request.URL.Path, "/v1/") {
		return nil, fmt.Errorf("TypeSafe transport requires its native API origin")
	}
	if account == nil {
		return nil, fmt.Errorf("TypeSafe account is missing")
	}
	token, _ := account.Metadata["token"].(string)
	if token == "" {
		return nil, fmt.Errorf("TypeSafe token is missing")
	}
	outgoing := request.Clone(ctx)
	outgoing.Header = request.Header.Clone()
	outgoing.Header.Set("Authorization", "Bearer "+token)
	client := helps.NewProxyAwareHTTPClient(ctx, e.cfg, account, 0)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return client.Do(outgoing)
}

func (e *executor) ExecuteStream(context.Context, *auth.Auth, coreexecutor.Request, coreexecutor.Options) (*coreexecutor.StreamResult, error) {
	return nil, terminal(415, []byte(`{"detail":"TypeSafe System One does not stream"}`), nil)
}
func (e *executor) Refresh(_ context.Context, account *auth.Auth) (*auth.Auth, error) {
	return account.Clone(), nil
}
func (e *executor) CountTokens(context.Context, *auth.Auth, coreexecutor.Request, coreexecutor.Options) (coreexecutor.Response, error) {
	return coreexecutor.Response{}, terminal(415, []byte(`{"detail":"TypeSafe has no token-count endpoint"}`), nil)
}

func terminal(status int, body []byte, headers http.Header) error {
	selected := make(http.Header)
	for name, values := range headers {
		key := strings.ToLower(name)
		if key == "retry-after" || key == "content-type" || key == "x-request-id" || strings.HasPrefix(key, "x-ratelimit-") {
			selected[name] = append([]string(nil), values...)
		}
	}
	return &coreexecutor.RequestTerminatedError{HTTPStatus: status, Header: selected, Body: body}
}
