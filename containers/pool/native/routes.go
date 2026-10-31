package nativeapi

import (
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/home"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

const Provider = "typesafe"
const Protocol = "typesafe-systemone"

// Routes shares the server's existing authentication manager and execution context.
func Routes(authenticate gin.HandlerFunc) api.ServerOption {
	return api.WithRouterConfigurator(func(engine *gin.Engine, base *handlers.BaseAPIHandler, cfg *config.Config) {
		handler := &handler{BaseAPIHandler: base}
		base.AuthManager.RegisterExecutor(&executor{cfg: cfg})
		engine.POST("/v1/systemone", authenticate, handler.systemOne)
		engine.POST("/typesafe/v1/systemone", authenticate, handler.systemOne)
		engine.GET("/typesafe/v1/models", authenticate, handler.models)
	})
}

type handler struct{ *handlers.BaseAPIHandler }

func (h *handler) HandlerType() string      { return Protocol }
func (h *handler) Models() []map[string]any { return nil }

func (h *handler) systemOne(c *gin.Context) {
	raw, errRead := io.ReadAll(io.LimitReader(c.Request.Body, maxBody+1))
	if errRead != nil {
		c.JSON(400, gin.H{"detail": "Cannot read request body"})
		return
	}
	body, errDecode := decodeBody(raw, c.Request.Header)
	if errDecode != nil {
		writeBodyError(c, errDecode)
		return
	}
	model, errModel := modelFromBody(body, c.GetHeader("Content-Type"))
	if errModel != nil {
		writeBodyError(c, errModel)
		return
	}
	ctx, cancel := h.GetContextWithCancel(h, c, c.Request.Context())
	defer cancel(nil)
	response, failed := h.ExecuteProtocolWithAuthManager(ctx, handlers.ProtocolExecutionRequest{
		EntryProtocol: Protocol, ExitProtocol: Protocol, ForcedProvider: Provider,
		Model: model, Body: raw, Headers: c.Request.Header.Clone(), Query: c.Request.URL.Query(), Path: c.Request.URL.Path,
	})
	if failed != nil {
		if failed.DirectResponse {
			for name, values := range failed.Headers {
				c.Writer.Header()[name] = values
			}
			c.Data(failed.StatusCode, "application/json", failed.Body)
		} else {
			h.WriteErrorResponse(c, failed)
		}
		return
	}
	handlers.WriteUpstreamHeaders(c.Writer.Header(), response.Headers)
	c.Data(response.StatusCode, "application/json", response.Body)
}

func writeBodyError(c *gin.Context, err error) {
	if failed, ok := err.(*bodyError); ok {
		c.JSON(failed.status, gin.H{"detail": failed.message})
		return
	}
	c.JSON(400, gin.H{"detail": "Invalid native request"})
}

type catalogModel struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Description string `json:"description"`
	Version     string `json:"version"`
}

func (h *handler) models(c *gin.Context) {
	client := home.Current()
	if client == nil {
		c.JSON(503, gin.H{"detail": "Home is unavailable"})
		return
	}
	raw, errGet := client.GetModels(c.Request.Context(), c.Request.Header, c.Request.URL.Query())
	if errGet != nil {
		c.JSON(502, gin.H{"detail": "Home model discovery failed"})
		return
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		c.JSON(502, gin.H{"detail": "Invalid Home catalog"})
		return
	}
	if failed, exists := top["error"]; exists {
		status := http.StatusBadGateway
		if strings.Contains(string(failed), "invalid_credential") || strings.Contains(string(failed), "no_credentials") {
			status = http.StatusUnauthorized
		}
		c.JSON(status, gin.H{"detail": "Home refused model discovery"})
		return
	}
	var models []catalogModel
	if data, exists := top[Provider]; exists {
		if err := json.Unmarshal(data, &models); err != nil {
			c.JSON(502, gin.H{"detail": "Invalid native model catalog"})
			return
		}
	}
	result := make([]map[string]string, 0, len(models))
	seen := make(map[string]bool)
	for _, model := range models {
		if model.Type != "native:"+Protocol || model.ID == "" || seen[model.ID] {
			continue
		}
		seen[model.ID] = true
		result = append(result, map[string]string{"name": model.ID, "description": model.Description, "release_date": model.Version})
	}
	sort.Slice(result, func(i, j int) bool { return result[i]["name"] < result[j]["name"] })
	h.WriteModelListResponse(c, Protocol, gin.H{"models": result})
}
