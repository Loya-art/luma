# Contributing

Please include the Luma version, Windows version, reproducible steps and expected
behavior in bug reports. Use sample files that you are permitted to share.
Do not attach a personal library database, API key, identity document or chat log.

Use Node.js 24 or newer and Windows for native desktop validation:

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` obtains a pinned public HEIC fixture on its first run. To build the
installer, make FFmpeg and ffprobe available on PATH or set `FFMPEG_PATH` and
`FFPROBE_PATH`, then run `npm run dist`. Packaging obtains ADB and uv from their
official distributions.

Keep original photo files unchanged except for an explicit confirmed recycle-bin
action. Preserve manual classifications, source identities and the legacy
`%APPDATA%/拾光` library location when changing display branding.

Desktop tests must use an isolated `SHIGUANG_DATA_DIR` and close their own processes
in `finally`. Tests may use `SHIGUANG_TEST_MODE=1` and `SHIGUANG_HIDDEN_TEST=1` to run
an invisible desktop renderer. Do not attach to or terminate another running app.

For visual changes, include screenshots made with non-private demonstration
media. A passing layout test is useful evidence, but does not replace inspecting
the actual interface and transition behavior.

Contributions are provided under this repository's AGPL-3.0-only license.
