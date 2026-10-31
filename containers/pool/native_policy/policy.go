package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

const (
	maxSafeInteger    int64 = 1<<53 - 1
	maxProjectionTTL        = 15 * time.Second
	maxAssertionTTL         = 2 * time.Hour
	maxAccountIDs           = 4096
	maxAccountIDBytes       = 512
	policyHeader            = "x-signalbox-native-policy"
)

type projectionClaims struct {
	Pool         string   `json:"pool"`
	Organization string   `json:"organization"`
	Revision     int64    `json:"revision"`
	ExpiresAt    int64    `json:"expiresAt"`
	Accounts     []string `json:"accounts"`
	Dirty        bool     `json:"dirty"`
}

type assertionClaims struct {
	Pool      string `json:"pool"`
	Revision  int64  `json:"revision"`
	ExpiresAt int64  `json:"expiresAt"`
}

type policySnapshot struct {
	claims   projectionClaims
	allowed  map[string]struct{}
	deadline time.Time
}

type policyRegistry struct {
	byPool map[string]*policySnapshot
}

type pickDecision struct {
	handled bool
	code    string
}

func decodeProjection(keys signingKeys, token string, now time.Time) (*policySnapshot, error) {
	payload, errVerify := keys.verify(token, projectionPrefix)
	if errVerify != nil {
		return nil, errInvalidEnvelope
	}
	var claims projectionClaims
	if errDecode := decodeStrict(payload, &claims); errDecode != nil || !validProjection(claims) {
		return nil, errInvalidEnvelope
	}
	remaining := time.Duration(claims.ExpiresAt-now.UnixMilli()) * time.Millisecond
	if remaining <= 0 || remaining > maxProjectionTTL {
		return nil, errInvalidEnvelope
	}
	allowed := make(map[string]struct{}, len(claims.Accounts))
	for _, id := range claims.Accounts {
		if _, exists := allowed[id]; exists {
			return nil, errInvalidEnvelope
		}
		allowed[id] = struct{}{}
	}
	return &policySnapshot{
		claims:   claims,
		allowed:  allowed,
		deadline: now.Add(remaining),
	}, nil
}

func decodeAssertion(keys signingKeys, token string) (assertionClaims, error) {
	payload, errVerify := keys.verify(token, assertionPrefix)
	if errVerify != nil {
		return assertionClaims{}, errInvalidEnvelope
	}
	var claims assertionClaims
	if errDecode := decodeStrict(payload, &claims); errDecode != nil || !validAssertion(claims) {
		return assertionClaims{}, errInvalidEnvelope
	}
	return claims, nil
}

func decodeStrict(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if errDecode := decoder.Decode(target); errDecode != nil {
		return errDecode
	}
	var trailing any
	if errDecode := decoder.Decode(&trailing); !errors.Is(errDecode, io.EOF) {
		return fmt.Errorf("trailing JSON")
	}
	return nil
}

func validProjection(claims projectionClaims) bool {
	if !safeIdentifier(claims.Pool) || !safeIdentifier(claims.Organization) ||
		!safeRevision(claims.Revision) || !safeTimestamp(claims.ExpiresAt) ||
		len(claims.Accounts) > maxAccountIDs {
		return false
	}
	for _, id := range claims.Accounts {
		if id == "" || len(id) > maxAccountIDBytes || strings.TrimSpace(id) != id {
			return false
		}
	}
	return true
}

func validAssertion(claims assertionClaims) bool {
	return safeIdentifier(claims.Pool) && safeRevision(claims.Revision) && safeTimestamp(claims.ExpiresAt)
}

func safeIdentifier(value string) bool {
	return value != "" && len(value) <= 512 && strings.TrimSpace(value) == value
}

func safeRevision(value int64) bool {
	return value > 0 && value <= maxSafeInteger
}

func safeTimestamp(value int64) bool {
	return value > 0 && value <= maxSafeInteger
}

func samePolicy(left, right projectionClaims) bool {
	if left.Pool != right.Pool || left.Organization != right.Organization || left.Dirty != right.Dirty || len(left.Accounts) != len(right.Accounts) {
		return false
	}
	leftSet := make(map[string]struct{}, len(left.Accounts))
	for _, id := range left.Accounts {
		leftSet[id] = struct{}{}
	}
	for _, id := range right.Accounts {
		if _, exists := leftSet[id]; !exists {
			return false
		}
	}
	return true
}

func assertionHeader(headers map[string][]string) (string, bool, bool) {
	var value string
	found := false
	for name, values := range headers {
		if !strings.EqualFold(strings.TrimSpace(name), policyHeader) {
			continue
		}
		if found || len(values) != 1 {
			return "", true, false
		}
		found = true
		value = values[0]
	}
	return value, found, !found || value != ""
}

func evaluatePick(req pluginapi.SchedulerPickRequest, registry *policyRegistry, keys signingKeys, now time.Time) pickDecision {
	token, found, validHeader := assertionHeader(req.Options.Headers)
	if !found {
		return pickDecision{}
	}
	if !validHeader {
		return pickDecision{handled: true, code: "native_policy_invalid"}
	}
	assertion, errAssertion := decodeAssertion(keys, token)
	assertionRemaining := time.Duration(assertion.ExpiresAt-now.UnixMilli()) * time.Millisecond
	if errAssertion != nil || assertionRemaining <= 0 || assertionRemaining > maxAssertionTTL {
		return pickDecision{handled: true, code: "native_policy_invalid"}
	}
	var snapshot *policySnapshot
	if registry != nil {
		snapshot = registry.byPool[assertion.Pool]
	}
	if snapshot == nil || !now.Before(snapshot.deadline) || snapshot.claims.Dirty ||
		assertion.Revision != snapshot.claims.Revision {
		return pickDecision{handled: true, code: "native_policy_unavailable"}
	}
	for _, candidate := range req.Candidates {
		if candidate.ID == "" {
			return pickDecision{handled: true, code: "native_policy_denied"}
		}
		if _, permitted := snapshot.allowed[candidate.ID]; !permitted {
			return pickDecision{handled: true, code: "native_policy_denied"}
		}
	}
	return pickDecision{}
}
