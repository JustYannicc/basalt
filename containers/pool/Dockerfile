FROM --platform=$BUILDPLATFORM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337 AS source-fetch
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY releases.json sources.json fetch_sources.py ./
COPY patches ./patches
RUN python3 fetch_sources.py --destination /source

FROM golang:1.26.10-bookworm@sha256:23ce71337b726608afb1bc00986e630a05034a87a87ea1fc2cd1ae5cf33387eb AS source-build
ARG TARGETARCH
ENV GOMAXPROCS=2
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
COPY --from=source-fetch /source /source
COPY native /source/node/internal/nativeapi
RUN cd /source/home && go test -p=2 -mod=readonly ./internal/cluster ./internal/respserver/push ./internal/respserver ./cmd/home -run 'TestDiagnosticsPrivacy|TestDatabaseSnapshotIndexOnlyVersionsRemainCompatible' -count=1 && \
    cd /source/node && go test -p=2 -mod=readonly ./sdk/cliproxy/auth ./sdk/cliproxy/usage ./internal/redisqueue ./internal/runtime/executor/helps ./internal/logging -run MetadataOnly -count=1
RUN mkdir -p /out/home /out/node && \
    cd /source/home && \
    CGO_ENABLED=1 GOOS=linux GOARCH="$TARGETARCH" go build -p=2 -mod=readonly -buildvcs=false \
      -ldflags="-s -w -X main.Version=$(cat .build-version) -X main.Commit=$(cat .build-commit)" \
      -o /out/home/cli-proxy-api ./cmd/home && \
    cp LICENSE /out/home/LICENSE && \
    cd /source/node && \
    CGO_ENABLED=1 GOOS=linux GOARCH="$TARGETARCH" go build -p=2 -mod=readonly -buildvcs=false \
      -ldflags="-s -w -X main.Version=$(cat .build-version) -X main.Commit=$(cat .build-commit)" \
      -o /out/node/cli-proxy-api ./cmd/server && \
    cp LICENSE /out/node/LICENSE
RUN mkdir -p /out/plugins && \
    cd /source/gemini-cli && \
    CGO_ENABLED=1 go build -p=2 -mod=readonly -trimpath -buildmode=c-shared \
      -ldflags="-s -w -X main.pluginVersion=$(cat .build-version)" \
      -o /out/plugins/gemini-cli.so ./cmd/geminicli && \
    cp LICENSE /out/plugins/LICENSE-gemini-cli
COPY typesafe /build/typesafe
RUN cd /build/typesafe && CGO_ENABLED=1 go build -p=2 -mod=readonly -trimpath -buildmode=c-shared -ldflags="-s -w" -o /out/plugins/typesafe.so .
COPY plugin_probe.go /build/plugin_probe.go
COPY native_policy_home_test.go.tmpl /build/native_policy_home_test.go.tmpl
COPY native_policy_home_host_helper.go.tmpl /build/native_policy_home_host_helper.go
COPY native_policy /build/native_policy
RUN mkdir -p /out/plugins && \
    cd /build/native_policy && \
    CGO_ENABLED=1 go build -p=2 -mod=readonly -trimpath -buildmode=c-shared \
      -o /out/plugins/basalt-native-policy.so .
RUN cd /source/home && \
    printf '{"Replace":{"/source/home/internal/cliproxy/auth/native_policy_home_test.go":"/build/native_policy_home_test.go.tmpl"}}' \
      > /tmp/native-policy-overlay.json && \
    CGO_ENABLED=1 \
      POOL_NATIVE_POLICY_TEST_PLUGIN_DIR=/out/plugins \
      POOL_NATIVE_POLICY_SOCKET=/dev/shm/cliproxy-pool/native-policy-home-test.sock \
      POOL_APP_SIGNING_KEY=1111111111111111111111111111111111111111111111111111111111111111 \
      POOL_APP_SIGNING_KEY_PREVIOUS= \
      go test -p=2 -mod=readonly -overlay=/tmp/native-policy-overlay.json \
        ./internal/cliproxy/auth \
        -run '^TestNativePolicyPluginVetoesRealHomeDispatchAndPreservesBuiltinSelection$' \
        -count=1 -v && \
    rm -f /tmp/native-policy-overlay.json
RUN mkdir -p /source/home/cmd/native-policy-test && \
    cp /build/native_policy_home_host_helper.go /source/home/cmd/native-policy-test/main.go && \
    cd /source/home && \
    CGO_ENABLED=1 go build -p=2 -mod=readonly -buildvcs=false \
      -o /out/native-policy-test-host ./cmd/native-policy-test && \
    rm -rf /source/home/cmd/native-policy-test
RUN cd /source/node && \
    CGO_ENABLED=1 go build -p=2 -mod=readonly -o /out/plugin-probe /build/plugin_probe.go && \
    /out/plugin-probe /out/plugins && \
    cd /source/home && \
    CGO_ENABLED=1 go build -p=2 -mod=readonly -o /out/home-plugin-probe /build/plugin_probe.go && \
    /out/home-plugin-probe /out/plugins

FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337 AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system pool \
    && useradd --system --no-create-home --gid pool pool
WORKDIR /opt/pool
COPY __init__.py /opt/pool/__init__.py
COPY supervisor.py /opt/pool/supervisor.py
COPY child_signals.py /opt/pool/child_signals.py
COPY runtime_signals.py /opt/pool/runtime_signals.py
COPY pool_contract.py /opt/pool/pool_contract.py
COPY readiness.py /opt/pool/readiness.py
COPY policy_monitor.py /opt/pool/policy_monitor.py
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

FROM runtime-base AS runtime
COPY --from=source-build /out/home/cli-proxy-api /usr/local/bin/cliproxy-home
COPY --from=source-build /out/node/cli-proxy-api /usr/local/bin/cliproxy-node
COPY --from=source-build /out/home/LICENSE /usr/share/licenses/cliproxy-home/LICENSE
COPY --from=source-build /out/node/LICENSE /usr/share/licenses/cliproxy-node/LICENSE

COPY --from=source-build /out/plugins/gemini-cli.so /opt/pool/plugins/gemini-cli.so
COPY --from=source-build /out/plugins/basalt-native-policy.so /opt/pool/plugins/basalt-native-policy.so
COPY --from=source-build /out/plugins/typesafe.so /opt/pool/plugins/typesafe.so
COPY --from=source-build /out/plugins/LICENSE-gemini-cli /usr/share/licenses/gemini-cli/LICENSE
# Probe shadow copies are build evidence, not runtime image contents.
RUN --mount=from=source-build,source=/out/plugin-probe,target=/tmp/plugin-probe \
    --mount=from=source-build,source=/out/home-plugin-probe,target=/tmp/home-plugin-probe \
    /tmp/plugin-probe /opt/pool/plugins && \
    /tmp/home-plugin-probe /opt/pool/plugins && \
    rm -rf /tmp/cliproxy-pluginhost
RUN --mount=from=source-build,source=/out/native-policy-test-host,target=/tmp/native-policy-test-host \
    --mount=type=bind,source=test_native_policy_integration.py,target=/tmp/test-native-policy-integration.py,readonly \
    --mount=type=bind,source=test_native_policy_observation.py,target=/tmp/test_native_policy_observation.py,readonly \
    POOL_NATIVE_POLICY_TEST_HOST=/tmp/native-policy-test-host \
    POOL_NATIVE_POLICY_TEST_PLUGIN_DIR=/opt/pool/plugins \
    PYTHONPATH=/opt python3 /tmp/test-native-policy-integration.py
