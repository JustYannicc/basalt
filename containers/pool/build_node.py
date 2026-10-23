"""Apply carried patches and build the node from its verified release source."""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys


def build(architecture: str) -> None:
    if architecture not in ("amd64", "arm64"):
        raise ValueError("unsupported node architecture")
    root = pathlib.Path(__file__).resolve().parent
    node = json.loads((root / "releases.json").read_text())["artifacts"]["node"]
    source = pathlib.Path("/source")
    for patch in node["patches"]:
        subprocess.run(["git", "apply", "--check", str(root / "patches" / patch)], cwd=source, check=True)
        subprocess.run(["git", "apply", str(root / "patches" / patch)], cwd=source, check=True)
    environment = {**os.environ, "CGO_ENABLED": "0", "GOTOOLCHAIN": "local"}
    subprocess.run(
        ["go", "test", "./internal/client/codex/models", "./internal/api"],
        cwd=source, env=environment, check=True,
    )
    subprocess.run(
        ["go", "test", "./internal/runtime/executor", "-run", "^TestClaudeFastCatalogTierTranslatesToAnthropicSpeedAndBeta$", "-count=1"],
        cwd=source, env=environment, check=True,
    )
    output = pathlib.Path("/out/node")
    output.mkdir(parents=True, exist_ok=True)
    flags = f'-s -w -X main.Version={node["tag"]} -X main.Commit={node["commit"]} -X main.BuildDate={node["build_date"]}'
    subprocess.run(
        ["go", "build", "-trimpath", "-buildvcs=false", f"-ldflags={flags}", "-o", str(output / node["binary"]), "./cmd/server/"],
        cwd=source, env={**environment, "GOOS": "linux", "GOARCH": architecture}, check=True,
    )
    shutil.copyfile(source / "LICENSE", output / "LICENSE")


if __name__ == "__main__":
    build(sys.argv[1])
