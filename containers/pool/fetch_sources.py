#!/usr/bin/env python3
"""Fetch pinned pool sources and apply only checksum-bound carries."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tarfile
import urllib.request


def verified_file(path: pathlib.Path, expected: str) -> None:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise ValueError(f"source or carry checksum mismatch: {path.name}")


def extract_source(archive: pathlib.Path, destination: pathlib.Path) -> None:
    with tarfile.open(archive, "r:gz") as source:
        for member in source.getmembers():
            parts = pathlib.PurePosixPath(member.name).parts
            if not parts or member.name.startswith("/") or ".." in parts:
                raise ValueError("unsafe source archive path")
            target = destination.joinpath(*parts[1:])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile() and len(parts) > 1:
                target.parent.mkdir(parents=True, exist_ok=True)
                incoming = source.extractfile(member)
                if incoming is None:
                    raise ValueError("source archive file is unreadable")
                with incoming, target.open("wb") as out:
                    shutil.copyfileobj(incoming, out)
                target.chmod(member.mode & 0o755)
            else:
                raise ValueError("source archive contains a link or special file")


def prepare(root: pathlib.Path, destination: pathlib.Path) -> None:
    releases = json.loads((root / "releases.json").read_text())
    sources = json.loads((root / "sources.json").read_text())
    if sources.get("format_version") != 1:
        raise ValueError("unsupported sources.json format")
    for name in ("home", "node"):
        release = releases["artifacts"][name]
        source = sources["artifacts"][name]
        if source["commit"] != release["commit"] or source["repository"] != release["repository"]:
            raise ValueError(f"source does not match release pin: {name}")
        folder = destination / name
        folder.mkdir(parents=True, exist_ok=False)
        archive = destination / f"{name}.tar.gz"
        url = f"https://codeload.github.com/{source['repository']}/tar.gz/{source['commit']}"
        with urllib.request.urlopen(url, timeout=120) as incoming, archive.open("wb") as out:
            shutil.copyfileobj(incoming, out)
        verified_file(archive, source["sha256"])
        extract_source(archive, folder)
        for carry in source["patches"]:
            filename = carry["file"]
            if pathlib.PurePosixPath(filename).name != filename:
                raise ValueError("carry must be a filename")
            patch = root / "patches" / filename
            verified_file(patch, carry["sha256"])
            subprocess.run(["git", "apply", "--check", str(patch.resolve())], cwd=folder, check=True)
            subprocess.run(["git", "apply", str(patch.resolve())], cwd=folder, check=True)
        (folder / ".build-version").write_text(release["tag"])
        (folder / ".build-commit").write_text(release["commit"])
        archive.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=pathlib.Path, required=True)
    args = parser.parse_args()
    prepare(pathlib.Path(__file__).resolve().parent, args.destination)
