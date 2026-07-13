# Garage Sale

A static, single-page garage-sale catalog — plain HTML/CSS/vanilla JS, no build
step. Item data is read live from a Google Sheet; photos live in
`assets/images/` (`web/` + `thumb/`). Deploys as-is to any static host.

Config is in `data/config.json` (title, currency, `reserveEmail`, and the Sheet
id). Note: `config.json` and the linked Sheet are publicly readable once
deployed, so keep nothing private in the Sheet.

Local-only helper (git-ignored): `tools/optimize-images.py` resizes originals in
`assets/images/` into the `web/` + `thumb/` copies the site serves.
