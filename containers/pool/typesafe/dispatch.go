package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

type callback struct {
	ID string `json:"host_callback_id"`
}

func dispatch(ctx context.Context, method string, raw []byte) (any, error) {
	switch method {
	case pluginabi.MethodPluginRegister, pluginabi.MethodPluginReconfigure:
		return map[string]any{
			"schema_version": 1,
			"metadata":       pluginapi.Metadata{Name: "TypeSafe System One", Version: "1.0.0", Author: "Basalt", GitHubRepository: "https://github.com/JustYannicc/basalt"},
			"capabilities": map[string]any{
				"auth_provider": true, "model_provider": true,
			},
		}, nil
	case pluginabi.MethodAuthIdentifier, pluginabi.MethodExecutorIdentifier:
		return map[string]string{"identifier": provider}, nil
	case pluginabi.MethodAuthParse:
		var req pluginapi.AuthParseRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, fmt.Errorf("invalid TypeSafe auth request")
		}
		return parseAuth(req)
	case pluginabi.MethodModelStatic:
		return pluginapi.ModelResponse{Provider: provider, Models: []pluginapi.ModelInfo{}}, nil
	case pluginabi.MethodModelForAuth:
		var req struct {
			pluginapi.AuthModelRequest
			callback
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, fmt.Errorf("invalid TypeSafe model request")
		}
		req.HTTPClient = hostHTTP{req.ID}
		return modelsForAuth(ctx, req.AuthModelRequest)
	case pluginabi.MethodAuthRefresh:
		var req pluginapi.AuthRefreshRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, fmt.Errorf("invalid TypeSafe refresh request")
		}
		return pluginapi.AuthRefreshResponse{Auth: pluginapi.AuthData{
			Provider: provider, ID: req.AuthID, StorageJSON: req.StorageJSON, Metadata: req.Metadata, Attributes: req.Attributes,
		}}, nil
	case pluginabi.MethodPluginQuiesce, pluginabi.MethodPluginShutdown:
		return struct{}{}, nil
	default:
		return nil, fmt.Errorf("This TypeSafe operation is not supported")
	}
}

func errorEnvelope(err error) []byte {
	encoded, _ := pluginabi.NewErrorEnvelope("typesafe_error", err.Error(), 502)
	return encoded
}
