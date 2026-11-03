"""Reproduce the licensed docs fonts from the recorded official release archive."""

import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

from fontTools import subset
from fontTools.ttLib import TTFont

output = Path(__file__).resolve().parents[2] / "assets/fonts/geist"
manifest = json.loads((output / "provenance.json").read_text())
archive_bytes = Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(archive_bytes).hexdigest() == manifest["archive_sha256"]

with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
    for record in manifest["files"]:
        source = archive.read(record["source"])
        assert hashlib.sha256(source).hexdigest() == record["source_sha256"]
        font = TTFont(io.BytesIO(source), recalcTimestamp=False)
        options = subset.Options()
        options.layout_features = ["*"]
        options.name_IDs = ["*"]
        options.name_legacy = True
        options.name_languages = ["*"]
        options.glyph_names = True
        options.recalc_timestamp = False
        selection = subset.Subsetter(options=options)
        selection.populate(unicodes=subset.parse_unicodes(record["unicodes"]))
        selection.subset(font)
        font.flavor = "woff2"
        data = io.BytesIO()
        font.save(data)
        assert hashlib.sha256(data.getvalue()).hexdigest() == record["sha256"]
        (output / record["file"]).write_bytes(data.getvalue())
