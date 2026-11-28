# The pinned aimock release (MIT); only its fixtures are ours. Its WORKDIR is /app.
FROM ghcr.io/copilotkit/aimock:1.48.1@sha256:103357ed9318b5ff7d5e1b6276dd7318cb958852a6a0ad91df5e30d4fdb5032e
COPY fixtures/ /app/fixtures/
CMD ["--fixtures", "/app/fixtures", "--host", "0.0.0.0", "--log-level", "warn", "--journal-max", "100"]
