"""Verify the integrity boundary for source-built pool carries."""

from __future__ import annotations

import hashlib
import io
import pathlib
import tarfile
import tempfile
import unittest

from .fetch_sources import extract_source, verified_file


class SourceIntegrityTests(unittest.TestCase):
    def test_source_and_carry_bytes_must_match_the_registered_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            file = pathlib.Path(temporary) / "carry.patch"
            file.write_bytes(b"reviewed carry")
            expected = hashlib.sha256(file.read_bytes()).hexdigest()
            verified_file(file, expected)
            file.write_bytes(b"modified carry")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                verified_file(file, expected)

    def test_archive_extracts_only_files_inside_its_root(self) -> None:
        for name, symlink in [("pin/../escape", False), ("/absolute", False), ("pin/link", True)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                archive = root / "source.tar.gz"
                with tarfile.open(archive, "w:gz") as out:
                    item = tarfile.TarInfo(name)
                    if symlink:
                        item.type = tarfile.SYMTYPE
                        item.linkname = "/outside"
                    out.addfile(item)
                with self.assertRaises(ValueError):
                    extract_source(archive, root / "out")

    def test_verified_archive_preserves_source_bytes_and_executable_bit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            archive = root / "source.tar.gz"
            with tarfile.open(archive, "w:gz") as out:
                item = tarfile.TarInfo("pin/build.sh")
                item.size, item.mode = 4, 0o755
                out.addfile(item, io.BytesIO(b"test"))
            extract_source(archive, root / "out")
            file = root / "out/build.sh"
            self.assertEqual(file.read_bytes(), b"test")
            self.assertEqual(file.stat().st_mode & 0o777, 0o755)


if __name__ == "__main__":
    unittest.main()
