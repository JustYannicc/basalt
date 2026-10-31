package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

const provider = "typesafe"
const protocol = "typesafe-systemone"
const upstream = "https://api.typesafe.ai/v1"

var errMissingToken = errors.New("TypeSafe credential has no token")

type credential struct {
	Type     string `json:"type"`
	Token    string `json:"token"`
	ProxyURL string `json:"proxy_url,omitempty"`
}

type modelCard struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	ReleaseDate string `json:"release_date"`
}

func parseAuth(req pluginapi.AuthParseRequest) (pluginapi.AuthParseResponse, error) {
	var saved credential
	if err := json.Unmarshal(req.RawJSON, &saved); err != nil {
		return pluginapi.AuthParseResponse{}, fmt.Errorf("invalid TypeSafe credential")
	}
	if saved.Type != provider {
		return pluginapi.AuthParseResponse{}, nil
	}
	if strings.TrimSpace(saved.Token) == "" || req.FileName == "" {
		return pluginapi.AuthParseResponse{Handled: true}, fmt.Errorf("TypeSafe token and credential identity are required")
	}
	var metadata map[string]any
	if err := json.Unmarshal(req.RawJSON, &metadata); err != nil {
		return pluginapi.AuthParseResponse{}, fmt.Errorf("invalid TypeSafe credential")
	}
	metadata["access_token"] = saved.Token
	return pluginapi.AuthParseResponse{Handled: true, Auth: pluginapi.AuthData{
		Provider: provider, ID: req.FileName, FileName: req.FileName,
		StorageJSON: req.RawJSON, Metadata: metadata, ProxyURL: saved.ProxyURL,
	}}, nil
}

func tokenFor(storage []byte, metadata map[string]any) (string, error) {
	var saved credential
	if len(storage) > 0 {
		if err := json.Unmarshal(storage, &saved); err != nil {
			return "", fmt.Errorf("invalid TypeSafe credential")
		}
	}
	if saved.Token == "" {
		saved.Token, _ = metadata["token"].(string)
	}
	if strings.TrimSpace(saved.Token) == "" {
		return "", errMissingToken
	}
	return saved.Token, nil
}

func modelsForAuth(ctx context.Context, req pluginapi.AuthModelRequest) (pluginapi.ModelResponse, error) {
	token, errToken := tokenFor(req.StorageJSON, req.Metadata)
	if errors.Is(errToken, errMissingToken) {
		// Home's secret-free projection cannot perform authenticated discovery.
		// Switch to live discovery when router-for-me/CLIProxyAPIHome#177 is released.
		return modelResponse([]modelCard{
			{Name: "jev-latest", Description: "Latest stable Jev System One model", ReleaseDate: "2026-10-14"},
			{Name: "jev-preview", Description: "Latest Jev System One preview alias", ReleaseDate: "2026-10-14"},
		})
	}
	if errToken != nil {
		return pluginapi.ModelResponse{}, errToken
	}
	if req.HTTPClient == nil {
		return pluginapi.ModelResponse{}, fmt.Errorf("TypeSafe host transport is unavailable")
	}
	response, errRequest := req.HTTPClient.Do(ctx, pluginapi.HTTPRequest{
		Method: http.MethodGet, URL: upstream + "/models", Headers: http.Header{
			"Authorization": {"Bearer " + token}, "Accept": {"application/json"},
		},
	})
	if errRequest != nil {
		return pluginapi.ModelResponse{}, fmt.Errorf("TypeSafe model discovery failed")
	}
	if response.StatusCode != http.StatusOK {
		return pluginapi.ModelResponse{}, fmt.Errorf("TypeSafe model discovery refused (%d)", response.StatusCode)
	}
	var catalog struct {
		Models []modelCard `json:"models"`
	}
	if err := json.Unmarshal(response.Body, &catalog); err != nil || catalog.Models == nil {
		return pluginapi.ModelResponse{}, fmt.Errorf("invalid TypeSafe model catalog")
	}
	return modelResponse(catalog.Models)
}

func modelResponse(cards []modelCard) (pluginapi.ModelResponse, error) {
	models := make([]pluginapi.ModelInfo, 0, len(cards))
	for _, card := range cards {
		if strings.TrimSpace(card.Name) == "" {
			return pluginapi.ModelResponse{}, fmt.Errorf("TypeSafe returned a model without a name")
		}
		released, _ := time.Parse("2006-01-02", card.ReleaseDate)
		created := int64(0)
		if !released.IsZero() {
			created = released.Unix()
		}
		models = append(models, pluginapi.ModelInfo{
			ID: card.Name, Name: card.Name, Object: "model", OwnedBy: provider,
			Type: "native:" + protocol, Version: card.ReleaseDate, Description: card.Description,
			Created: created, DisplayName: card.Name, SupportedGenerationMethods: []string{"/v1/systemone"},
		})
	}
	return pluginapi.ModelResponse{Provider: provider, Models: models}, nil
}
