#!/usr/bin/env python3
"""Fetch the pinned Home binary and node source named in releases.json."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import tarfile
import tempfile
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parent
USER_AGENT = "basalt-cli-proxy-pool-release-fetcher"


def download_verified(url: str, expected: str, output: pathlib.Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    digest = hashlib.sha256()

    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".release-", dir=output.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as destination, urllib.request.urlopen(
            request, timeout=120
        ) as response:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                destination.write(chunk)
            destination.flush()
            os.fsync(destination.fileno())
        actual = digest.hexdigest()
        if actual != expected:
            raise ValueError(f"SHA-256 mismatch for {output.name}")
        os.replace(temporary, output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def extract_binary(archive: pathlib.Path, binary: str, destination: pathlib.Path) -> None:
    with tarfile.open(archive, mode="r:gz") as package:
        matches = [
            member
            for member in package.getmembers()
            if member.name == binary and member.isfile()
        ]
        if len(matches) != 1:
            raise ValueError(f"expected one {binary} executable in {archive.name}")
        source = package.extractfile(matches[0])
        if source is None:
            raise ValueError(f"could not read {binary} from {archive.name}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with source, destination.open("wb") as executable:
            while chunk := source.read(1024 * 1024):
                executable.write(chunk)
        destination.chmod(0o755)
        licenses = [member for member in package.getmembers() if member.name == "LICENSE" and member.isfile()]
        if len(licenses) != 1:
            raise ValueError(f"expected one LICENSE in {archive.name}")
        license_source = package.extractfile(licenses[0])
        if license_source is None:
            raise ValueError(f"could not read LICENSE from {archive.name}")
        with license_source, (destination.parent / "LICENSE").open("wb") as license_file:
            license_file.write(license_source.read())


def fetch(manifest_path: pathlib.Path, architecture: str, destination: pathlib.Path) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format_version") != 1:
        raise ValueError("unsupported releases.json format")

    home = manifest["artifacts"]["home"]
    asset = home["assets"][architecture]
    archive = destination / "downloads" / asset["name"]
    url = f'https://github.com/{home["repository"]}/releases/download/{home["tag"]}/{asset["name"]}'
    download_verified(url, asset["sha256"], archive)
    extract_binary(archive, home["binary"], destination / "home" / home["binary"])
    archive.unlink()

    node = manifest["artifacts"]["node"]
    archive = destination / "downloads" / "node-source.tar.gz"
    url = f'https://api.github.com/repos/{node["repository"]}/tarball/{node["commit"]}'
    download_verified(url, node["source_sha256"], archive)
    with tarfile.open(archive, mode="r:gz") as package:
        # GitHub wraps the source in one directory. The data filter rejects
        # paths and links that could escape the extraction directory.
        roots = {pathlib.PurePosixPath(member.name).parts[0] for member in package.getmembers()}
        if len(roots) != 1:
            raise ValueError("expected one node source directory")
        source_root = destination / "node-source"
        source_root.mkdir(parents=True, exist_ok=True)
        package.extractall(source_root, filter="data")
        (source_root / roots.pop()).rename(destination / "source")
        source_root.rmdir()
    archive.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--arch", required=True, choices=("amd64", "arm64"))
    parser.add_argument("--destination", required=True, type=pathlib.Path)
    args = parser.parse_args()
    fetch(ROOT / "releases.json", args.arch, args.destination)


if __name__ == "__main__":
    main()
