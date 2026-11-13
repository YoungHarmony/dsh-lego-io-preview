# dsh-lego-io-preview

Read-only 3D preview for **BrickLink Studio `.io`** LEGO models, drawn in the
DSH right sidebar. Open an `.io` file from the workspace and the panel parses
its `modelv2.ldr`, resolves the part list against a bundled LDraw part set and
renders it with WebGL2 — no Studio install, no Python, no external converter.

## What it shows

- type-11 part lines from `modelv2.ldr` (falls back to `model.ldr`, then to
  classic type-1 LDraw lines)
- real LDraw geometry for the bundled parts, with their LDraw colours
- drag to orbit, wheel to zoom, shift-drag (or middle-drag) to pan,
  double-click to reset, grid on the model floor

Bundled parts (171 files, 171 903 triangles, built from the official LDraw
library): bricks 1×1–1×12 and 2×2–2×10, plates 1×1–1×8 and 2×2–4×8, tiles,
grille tiles, 45°/curved slopes, cheese slopes, round bricks/plates, technic
bricks/pins, windows, doors and a few minifig accessories.

## Requirements

- DSH `0.2.2-rc.1` or newer.
- **`dsh-better-sidebar` is strongly recommended**: the file tree of that plugin
  opens `.io` through its own viewer registry, and this plugin registers itself
  there. Without it DSH's built-in document preview renders the file instead.
- Studio 2.0 is optional. With Studio installed, every part the bundle does not
  cover is read from Studio's own LDraw library at runtime (see below); without
  it, unknown parts are drawn as boxes.

## Parts outside the bundle

Everything else is loaded on demand from the **LDraw library that Studio 2.0
ships with**, so a Studio user does not have to rebuild the bundle for a new
model:

1. the client parses the model and collects the part names it cannot draw;
2. it POSTs them to `/dsh-lego-io-preview/geom`, the plugin's host route;
3. the host indexes `<studio>/ldraw/parts` once (about 33 000 files, ~0.2 s),
   recursively expands the requested `.dat` files into triangles, caches them
   in `%LOCALAPPDATA%\dsh-lego-io-preview\geom-cache.json` and answers in batches;
4. the client merges the geometry and draws the model normally, showing
   `+N from the Studio library` in its status bar.

The host looks for the library at `<config.libraryPath>`,
`D:\Program Files\Studio 2.0\ldraw`, `C:\Program Files\Studio 2.0\ldraw`,
`%LOCALAPPDATA%\Studio 2.0\ldraw` and `/Applications/Studio 2.0/ldraw`
(macOS). If no library is found the preview simply falls back to the bundled
parts and reports the rest as missing, exactly as before.

## Adding parts

The geometry is baked into the bundle, so a part that is not in the payload is
a grey box. To add parts:

```powershell
# optional: point at any LDraw library (defaults to Studio's own library)
$env:BRICK_LDRAW = "D:\Program Files\Studio 2.0\ldraw"

# collect every part referenced by the models you care about
.\.venv\Scripts\python.exe build_parts.py --scan "C:\path\to\models" --extra "3005,54200"

.\.venv\Scripts\python.exe build_client.py
```

then restart the app host (or reload the plugin). `build_parts.py` prints the
part ids it could not resolve and the payload size, so keep an eye on it: the
payload is embedded in `client.js` and every extra 100 parts adds roughly
0.9 MiB to the bundle.

## Install

```powershell
dsh plugin --profile desktop add dsh-lego-io-preview
```

or from a checkout: `plugin_manager` → `install_bundle` with the absolute path
of this directory.

## License

MIT for the code (see `LICENSE`). The bundled part geometry is derived from the
[LDraw Parts Library](https://library.ldraw.org) and is redistributed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the full attribution
is in `LICENSE`. LEGO® and BrickLink® are trademarks of their owners; this
project is unofficial.

## Limits

- Read only: no editing, no saving, no BOM export.
- Legacy **encrypted** `.io` files (AES, `soho0909`) are rejected with a hint to
  re-save in Studio; only the current plain-zip format is read.
- Submodel references (`1 … <name>.ldr`) inside the model are not flattened.
- Very large models draw one call per placement; tens of thousands of parts will
  be slow rather than wrong.

## Layout

| File | Role |
| --- | --- |
| `index.js` | host half: `/dsh-lego-io-preview/status` and `/dsh-lego-io-preview/geom` |
| `client.js` | generated client bundle: preview registration, parser, renderer |
| `client.template.js` | readable source, `__PARTS_PAYLOAD__` is the build placeholder |
| `locale/*.json` | display title/description |
| `cordis.patch.yml` | bundle patch inserting the plugin |

`client.js` is generated from `client.template.js` plus
`../parts-payload.txt` (gzip + base64 of the extracted part geometry) by
`../build_client.py`; `../build_parts.py` regenerates the geometry from an
LDraw library at `../ldraw/ldraw`. `../test_client.mjs` checks the loader
contract, registrations and the `.io` parsing pipeline against real files
(including an end-to-end fetch from the host route); `../test_host.mjs` checks
the two host routes without a running DSH.
