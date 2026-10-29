FROM --platform=$BUILDPLATFORM python:3.12-alpine3.22@sha256:a190708a2dec1bd18b1decb539f8e8f5407abaa9bf39cacda583f7f8c11db322 AS source-fetch
RUN apk add --no-cache git
WORKDIR /build
COPY releases.json sources.json fetch_sources.py ./
COPY patches ./patches
RUN python3 fetch_sources.py --destination /source

FROM --platform=$BUILDPLATFORM golang:1.26.10-alpine@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS source-build
ARG TARGETARCH
COPY --from=source-fetch /source /source
RUN cd /source/home && go test -p=2 -mod=readonly ./internal/cluster ./internal/respserver/push ./internal/respserver -run TestDiagnosticsPrivacy -count=1 && \
    cd /source/node && go test -p=2 -mod=readonly ./sdk/cliproxy/auth ./sdk/cliproxy/usage ./internal/redisqueue ./internal/runtime/executor/helps -run MetadataOnly -count=1
RUN mkdir -p /out/home /out/node && \
    cd /source/home && \
    CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -p=2 -mod=readonly -buildvcs=false \
      -ldflags="-s -w -X main.Version=$(cat .build-version) -X main.Commit=$(cat .build-commit)" \
      -o /out/home/cli-proxy-api ./cmd/home && \
    cp LICENSE /out/home/LICENSE && \
    cd /source/node && \
    CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -p=2 -mod=readonly -buildvcs=false \
      -ldflags="-s -w -X main.Version=$(cat .build-version) -X main.Commit=$(cat .build-commit)" \
      -o /out/node/cli-proxy-api ./cmd/server && \
    cp LICENSE /out/node/LICENSE

FROM --platform=$BUILDPLATFORM python:3.12-alpine3.22@sha256:a190708a2dec1bd18b1decb539f8e8f5407abaa9bf39cacda583f7f8c11db322 AS legacy-fetch
ARG TARGETARCH
WORKDIR /build
COPY releases.json fetch_releases.py ./
RUN python3 fetch_releases.py --arch "$TARGETARCH" --destination /out

FROM python:3.12-alpine3.22@sha256:a190708a2dec1bd18b1decb539f8e8f5407abaa9bf39cacda583f7f8c11db322 AS runtime-base
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S pool \
    && adduser -S -D -H -G pool pool
WORKDIR /opt/pool
COPY __init__.py /opt/pool/__init__.py
COPY supervisor.py /opt/pool/supervisor.py
COPY pool_contract.py /opt/pool/pool_contract.py
COPY readiness.py /opt/pool/readiness.py
COPY healthcheck.py /opt/pool/healthcheck.py
ENV HOME=/dev/shm/cliproxy-pool \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt \
    TZ=Etc/UTC
EXPOSE 8317 8318 8327
HEALTHCHECK --interval=10s --timeout=4s --start-period=180s --retries=3 \
  CMD ["python3", "-m", "pool.healthcheck"]
USER pool
ENTRYPOINT ["python3", "-m", "pool.supervisor"]

# The upgrade regression starts the released binaries against its disposable DB.
FROM runtime-base AS legacy-runtime
COPY --from=legacy-fetch /out/home/cli-proxy-api /usr/local/bin/cliproxy-home
COPY --from=legacy-fetch /out/node/cli-proxy-api /usr/local/bin/cliproxy-node
COPY --from=legacy-fetch /out/home/LICENSE /usr/share/licenses/cliproxy-home/LICENSE
COPY --from=legacy-fetch /out/node/LICENSE /usr/share/licenses/cliproxy-node/LICENSE

FROM runtime-base AS runtime
COPY --from=source-build /out/home/cli-proxy-api /usr/local/bin/cliproxy-home
COPY --from=source-build /out/node/cli-proxy-api /usr/local/bin/cliproxy-node
COPY --from=source-build /out/home/LICENSE /usr/share/licenses/cliproxy-home/LICENSE
COPY --from=source-build /out/node/LICENSE /usr/share/licenses/cliproxy-node/LICENSE
