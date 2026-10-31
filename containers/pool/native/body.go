package nativeapi

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"

	"github.com/klauspost/compress/zstd"
)

const maxBody = 32 * 1024 * 1024

// The native envelope is inspected for routing. The wire body is retained for transport.
func decodeBody(raw []byte, headers http.Header) ([]byte, error) {
	if len(raw) > maxBody {
		return nil, &bodyError{413, "Request body exceeds 32 MiB"}
	}
	var reader io.Reader = bytes.NewReader(raw)
	switch headers.Get("Content-Encoding") {
	case "", "identity":
	case "gzip", "x-gzip":
		decoder, err := gzip.NewReader(reader)
		if err != nil {
			return nil, &bodyError{400, "Invalid compressed body"}
		}
		defer decoder.Close()
		reader = decoder
	case "zstd":
		decoder, err := zstd.NewReader(reader, zstd.WithDecoderMaxWindow(8*1024*1024), zstd.WithDecoderMaxMemory(maxBody), zstd.WithDecoderConcurrency(1))
		if err != nil {
			return nil, &bodyError{400, "Invalid compressed body"}
		}
		defer decoder.Close()
		reader = decoder
	default:
		return nil, &bodyError{415, "Unsupported content encoding"}
	}
	body, err := io.ReadAll(io.LimitReader(reader, maxBody+1))
	if err != nil {
		return nil, &bodyError{400, "Invalid compressed body"}
	}
	if len(body) > maxBody {
		return nil, &bodyError{413, "Decompressed body exceeds 32 MiB"}
	}
	return body, nil
}

func requestJSON(body []byte, contentType string) ([]byte, error) {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return nil, &bodyError{415, "Invalid content type"}
	}
	switch mediaType {
	case "application/json":
		return body, nil
	case "multipart/form-data":
		reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
		part, errPart := reader.NextPart()
		if errPart != nil || part.FormName() != "request" {
			return nil, &bodyError{400, "The first multipart part must be request"}
		}
		defer part.Close()
		data, errRead := io.ReadAll(io.LimitReader(part, maxBody+1))
		if errRead != nil {
			return nil, &bodyError{400, "Invalid multipart request"}
		}
		return data, nil
	default:
		return nil, &bodyError{415, "Expected JSON or multipart form data"}
	}
}

func modelFromBody(body []byte, contentType string) (string, error) {
	data, err := requestJSON(body, contentType)
	if err != nil {
		return "", err
	}
	var envelope struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return "", &bodyError{400, "Invalid JSON request"}
	}
	if envelope.Model == "" {
		return "", &bodyError{422, "A model is required"}
	}
	return envelope.Model, nil
}

// Replace only the native JSON part; image bytes and part headers remain intact.
func replaceJSON(body []byte, contentType string, replacement []byte) ([]byte, string, error) {
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return nil, "", err
	}
	if mediaType == "application/json" {
		return replacement, contentType, nil
	}
	var out bytes.Buffer
	writer := multipart.NewWriter(&out)
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	first := true
	for {
		part, errPart := reader.NextRawPart()
		if errors.Is(errPart, io.EOF) {
			break
		}
		if errPart != nil {
			return nil, "", fmt.Errorf("Invalid multipart body")
		}
		destination, errCreate := writer.CreatePart(part.Header)
		if errCreate != nil {
			return nil, "", errCreate
		}
		if first {
			_, err = destination.Write(replacement)
			first = false
		} else {
			_, err = io.Copy(destination, part)
		}
		if err != nil {
			return nil, "", err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return out.Bytes(), writer.FormDataContentType(), nil
}

type bodyError struct {
	status  int
	message string
}

func (e *bodyError) Error() string { return e.message }
