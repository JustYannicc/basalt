"""Verify offline compatibility images retain the release archive integrity boundary."""

from __future__ import annotations

import hashlib
import io
import json
import os
import pathlib
import tarfile
import tempfile
import unittest
from unittest import mock

from . import fetch_releases


class ReleaseArchiveCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.cache = self.root / "cache"
        self.cache.mkdir()
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for name, data in [("cli-proxy-api", b"pinned executable"), ("LICENSE", b"license")]:
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        self.bytes = buffer.getvalue()
        self.sha256 = hashlib.sha256(self.bytes).hexdigest()
        self.archive = self.cache / f"{self.sha256}.tar.gz"
        self.archive.write_bytes(self.bytes)
        self.asset = {"name": "fixture.tar.gz", "sha256": self.sha256}
        artifact = {"repository": "fixture/pool", "tag": "v1.fixture", "binary": "cli-proxy-api", "assets": {"amd64": self.asset}}
        self.manifest = self.root / "releases.json"
        self.manifest.write_text(json.dumps({"format_version": 1, "artifacts": {"home": artifact, "node": artifact}}))

    def test_verified_cache_hits_extract_binaries_without_any_network_request(self) -> None:
        with mock.patch.dict(os.environ, {"BASALT_POOL_RELEASE_ARCHIVE_DIR": str(self.cache)}), mock.patch.object(
            fetch_releases.urllib.request, "urlopen", side_effect=AssertionError("Network is forbidden")
        ):
            for attempt in range(2):
                destination = self.root / f"out-{attempt}"
                fetch_releases.fetch(self.manifest, "amd64", destination)
                for role in ("home", "node"):
                    self.assertEqual((destination / role / "cli-proxy-api").read_bytes(), b"pinned executable")
                    self.assertEqual((destination / role / "LICENSE").read_bytes(), b"license")
                    self.assertEqual((destination / role / "cli-proxy-api").stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.archive.read_bytes(), self.bytes)

    def test_missing_and_corrupt_cache_entries_never_fall_back_to_a_download(self) -> None:
        with mock.patch.dict(os.environ, {"BASALT_POOL_RELEASE_ARCHIVE_DIR": str(self.cache)}), mock.patch.object(
            fetch_releases.urllib.request, "urlopen", side_effect=AssertionError("Network is forbidden")
        ):
            self.archive.unlink()
            with self.assertRaisesRegex(FileNotFoundError, f"fixture/pool v1.fixture/fixture.tar.gz; SHA-256 {self.sha256}"):
                fetch_releases.fetch(self.manifest, "amd64", self.root / "missing")
            self.archive.write_bytes(b"corrupted")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                fetch_releases.fetch(self.manifest, "amd64", self.root / "corrupt")
            self.assertFalse((self.root / "corrupt/home/cli-proxy-api").exists())

    def test_without_a_cache_override_the_existing_download_and_checksum_path_remains(self) -> None:
        with mock.patch.dict(os.environ):
            os.environ.pop("BASALT_POOL_RELEASE_ARCHIVE_DIR", None)
            with mock.patch.object(fetch_releases.urllib.request, "urlopen", return_value=io.BytesIO(self.bytes)) as download:
                output = self.root / "downloaded.tar.gz"
                fetch_releases.download_verified("fixture/pool", "v1.fixture", self.asset, output)
                self.assertEqual(output.read_bytes(), self.bytes)
                self.assertEqual(download.call_args.args[0].full_url, "https://github.com/fixture/pool/releases/download/v1.fixture/fixture.tar.gz")
            with mock.patch.object(fetch_releases.urllib.request, "urlopen", return_value=io.BytesIO(b"corrupt")):
                with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                    fetch_releases.download_verified("fixture/pool", "v1.fixture", self.asset, self.root / "refused.tar.gz")


if __name__ == "__main__":
    unittest.main()
