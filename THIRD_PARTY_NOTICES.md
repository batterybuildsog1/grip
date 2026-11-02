# Third-party notices

Grip derives from Vincent Yang's MailClaw (initial commit
b647401f8256ddf409e146f478625da1991ca5dd, 2026-03-10), whose README declares MIT.
The original MailClaw MIT notice is retained in `docs/oss/MailClaw-MIT.txt`
(`licenses/MailClaw-MIT.txt` in the public export). Its copyright attribution
was reconstructed from the upstream author/date and README, not copied from an
upstream license file. Grip additions are licensed under AGPL-3.0-only; the
full text is in the root LICENSE. Copyright (c) 2026 Alan Knudson.
The Grip icons were drawn for this project from hand-written geometry
(no image-generation service) and are covered by the same grant.

Bundled components retain their own licenses; the root AGPL grant does not
relicense them. Preserve their notices when redistributing source or builds.

- Instrument Sans: Copyright 2022 The Instrument Sans Project Authors.
- Literata: Copyright 2017 The Literata Project Authors.
  Both fonts are SIL OFL 1.1. Full licenses and download provenance are
  beside the unmodified WOFF2 files in `ui/public/fonts/`. OFL permits bundling
  with software; preserve the notices and do not sell the fonts on their own.
  Renaming restrictions apply to modified fonts with reserved names.
- GRDB.swift 7.11.1: Copyright (C) 2015–2025 Gwendal Roué, MIT. The pinned Swift
  package revision is b83108d10f42680d78f23fe4d4d80fc88dab3212. The full license
  accompanies the export at `licenses/GRDB-LICENSE.txt`.
- `worker-configuration.d.ts`: generated Cloudflare/Microsoft runtime types,
  Apache-2.0. Preserve its embedded copyright/license notice; the full Apache
  license accompanies the export at `licenses/Apache-2.0.txt`.
- npm/Bun: 735 exact package versions across the backend and web lockfiles.
  Exact versions, SPDX declarations, repositories and registry source URLs are
  listed in the export at `licenses/npm-license-inventory.json` (private audit
  source: `docs/oss/npm-license-inventory.json`). This includes development and
  platform-optional dependencies, not just browser-bundled code.
  MIT, ISC, BSD, Apache, 0BSD, MIT-0, BlueOak and dual-license packages require
  retaining the applicable notices; choose the BSD option for
  `(AFL-2.1 OR BSD-3-Clause)`. `caniuse-lite` data is CC-BY-4.0: retain its data
  attribution. Sharp/libvips platform packages include LGPL-3.0-or-later code:
  dependency references do not relicense Grip, but shipping those binaries
  requires their full notices, license and corresponding-source/relinking
  obligations. The sanitized source export includes no dependency binaries.
  Production JS/native bundles still require a generated included-component
  notice set; registry metadata alone is not that notice set.
- Map rendering uses MapLibre GL (BSD-3-Clause), PMTiles (BSD-3-Clause), and
  Protomaps basemaps (BSD-3-Clause). The map view retains OpenStreetMap
  attribution. External tile/glyph data are not included in the export:
  operators must verify their own datasets' licenses and attribution.
  Private demo-route data derived from OpenStreetMap/OSRM (ODbL 1.0) are
  excluded; those data are not covered by the root AGPL license.

App icons and design-kit-derived map styling have no separate third-party
license grant in this checkout. Their creator/rights provenance must be confirmed
before release. Their presence in a sanitized candidate is not rights clearance.
