package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

const (
	assertionPrefix  = "sbm-use1"
	projectionPrefix = "sbm-policy1"
)

var errInvalidEnvelope = errors.New("invalid signed envelope")

type signingKeys struct {
	current  []byte
	previous []byte
}

func decodeSigningKey(value string) ([]byte, error) {
	if len(value) != 64 || strings.ToLower(value) != value {
		return nil, errInvalidEnvelope
	}
	key, errDecode := hex.DecodeString(value)
	if errDecode != nil || len(key) != sha256.Size {
		return nil, errInvalidEnvelope
	}
	return key, nil
}

func (keys signingKeys) verify(token, prefix string) ([]byte, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != prefix {
		return nil, errInvalidEnvelope
	}
	payload, errPayload := decodeBase64URL(parts[1])
	if errPayload != nil {
		return nil, errInvalidEnvelope
	}
	signature, errSignature := decodeBase64URL(parts[2])
	if errSignature != nil || len(signature) != sha256.Size {
		return nil, errInvalidEnvelope
	}
	signed := []byte(prefix + "." + parts[1])
	for _, key := range [][]byte{keys.current, keys.previous} {
		if len(key) != sha256.Size {
			continue
		}
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write(signed)
		if hmac.Equal(signature, mac.Sum(nil)) {
			return payload, nil
		}
	}
	return nil, errInvalidEnvelope
}

func encodeBase64URL(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

func decodeBase64URL(value string) ([]byte, error) {
	if value == "" || strings.ContainsAny(value, "=+/") {
		return nil, errInvalidEnvelope
	}
	decoded, errDecode := base64.RawURLEncoding.DecodeString(value)
	if errDecode != nil || encodeBase64URL(decoded) != value {
		return nil, errInvalidEnvelope
	}
	return decoded, nil
}

func signEnvelope(key []byte, prefix string, payload []byte) string {
	encoded := encodeBase64URL(payload)
	signed := prefix + "." + encoded
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(signed))
	return signed + "." + encodeBase64URL(mac.Sum(nil))
}
