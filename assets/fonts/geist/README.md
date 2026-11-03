These Geist and Geist Mono files keep the documentation build independent of
Google Fonts. They come from the official [Geist 1.8.0 release](https://github.com/vercel/geist-font/releases/tag/1.8.0)
under the SIL Open Font License in [OFL.txt](OFL.txt).

Both normal and italic faces retain the existing Latin glyph coverage. Their
variable axes are unchanged. The local Astro configuration keeps the ranges the
docs already request: 400 to 700 for Geist and 400 to 600 for Geist Mono. Blume's local-font configuration also supplies the OG image renderer.

[provenance.json](provenance.json) records the release archive, source and output
hashes, character sets and CSS range. To reproduce the files from that archive:

```sh
uv run --no-project --with 'fonttools[woff]==4.61.1' python scripts/docs-fonts/subset.py /path/to/geist-font-1.8.0.zip
```

`node scripts/docs-fonts/check.ts` builds the docs with empty font caches and
both Google font hosts blocked, then verifies the emitted assets and CSS.
