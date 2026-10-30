# Third-party notices

Luma's application source is licensed under AGPL-3.0-only. Third-party programs,
packages, model weights and demonstration media retain their own licenses.

## Inspiration

[Folia](https://github.com/chthollyphile/folia-major), by chthollyphile and its
contributors, inspired the immersive mosaic wall, repeated wall navigation and
quiet translucent controls. Folia is licensed under AGPL-3.0. Luma focuses on local
photo and video management. Folia's branding, music, covers and screenshots are
not part of the demonstration media in this repository.

## Application dependencies

| Component | License | Upstream |
| --- | --- | --- |
| Electron | MIT, with Chromium and other third-party notices | https://github.com/electron/electron |
| React / React DOM | MIT | https://github.com/facebook/react |
| Lucide icons | ISC | https://github.com/lucide-icons/lucide |
| Sharp | Apache-2.0; bundled native libraries have their own notices | https://github.com/lovell/sharp |
| libheif-js | LGPL-3.0 | https://github.com/catdad-experiments/libheif-js |
| libheif | LGPL-3.0 | https://github.com/strukturag/libheif |
| exifr | MIT | https://github.com/MikeKovarik/exifr |
| chokidar | MIT | https://github.com/paulmillr/chokidar |
| node-qrcode | MIT | https://github.com/soldair/node-qrcode |

The exact package graph and versions are in `package-lock.json`. Preserve the
licenses supplied with installed packages when distributing compiled software.

## Separate runtime programs

- **FFmpeg / ffprobe** are launched as separate processes. The build used locally
  is a GPLv3-enabled Gyan build. This source repository does not redistribute the
  executables. Builds and source information: https://www.gyan.dev/ffmpeg/builds/
  and https://ffmpeg.org/legal.html. Distributors must provide the notices and
  corresponding source required by the particular FFmpeg build they distribute.
- **Android Platform Tools / ADB** are obtained from Google's official archive;
  its bundled `NOTICE.txt` is preserved as `resources/binaries/ADB-LICENSE.txt`.
  https://developer.android.com/tools/releases/platform-tools
- **uv** is MIT OR Apache-2.0. License copies are in `resources/binaries/`.
  https://github.com/astral-sh/uv
- **Managed Python, PaddleOCR/RapidOCR, Chinese-CLIP and their dependencies** are
  installed only after local analysis is requested. Model and package licenses
  remain applicable; model weights are not included in this source repository.
  https://github.com/PaddlePaddle/PaddleOCR
  https://github.com/RapidAI/RapidOCR
  https://github.com/OFA-Sys/Chinese-CLIP

## Demonstration media and test fixtures

- The demo is recorded from the real Luma desktop application using a separate
  demo library. It contains no personal photo library or real chat storage.
- Public landscape photos are used under the Unsplash license. Individual source
  links and usage notes are in [`docs/media/credits.md`](docs/media/credits.md).
- The flower video is MDN's CC0 example video.
- The HEIC compatibility test downloads libheif's upstream example into the
  ignored `tests/.fixtures/` directory and checks its pinned SHA-256.
