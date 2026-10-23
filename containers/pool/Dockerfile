FROM --platform=$BUILDPLATFORM python:3.12-alpine3.22@sha256:a190708a2dec1bd18b1decb539f8e8f5407abaa9bf39cacda583f7f8c11db322 AS release-fetch
ARG TARGETARCH
WORKDIR /build
COPY releases.json fetch_releases.py ./
RUN python3 fetch_releases.py --arch "$TARGETARCH" --destination /out

FROM python:3.12-alpine3.22@sha256:a190708a2dec1bd18b1decb539f8e8f5407abaa9bf39cacda583f7f8c11db322
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S pool \
    && adduser -S -D -H -G pool pool
WORKDIR /opt/pool
COPY --from=release-fetch /out/home/cli-proxy-api /usr/local/bin/cliproxy-home
COPY --from=release-fetch /out/node/cli-proxy-api /usr/local/bin/cliproxy-node
COPY --from=release-fetch /out/home/LICENSE /usr/share/licenses/cliproxy-home/LICENSE
COPY --from=release-fetch /out/node/LICENSE /usr/share/licenses/cliproxy-node/LICENSE
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
