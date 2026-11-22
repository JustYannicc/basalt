FROM tailscale/tailscale@sha256:72c1e19e0aedca96b8533bbb0b4368564410ff20b17e53b804eb6c1f04a31be4 AS tailscale

FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system gateway \
    && useradd --system --no-create-home --gid gateway gateway
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
WORKDIR /opt/route-gateway
COPY adapter_tailscale.py forwarder.py control.py healthcheck.py /opt/route-gateway/
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/dev/shm/route-gateway
EXPOSE 1080 8080
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=3 \
  CMD ["python3", "/opt/route-gateway/healthcheck.py"]
USER gateway
ENTRYPOINT ["python3", "/opt/route-gateway/control.py"]
