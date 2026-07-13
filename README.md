# Garage Sale

A static, single-page garage-sale catalog — plain HTML/CSS/vanilla JS, no build
step. Item data is read live from an external data source; photos live in
`assets/images/` (`web/` + `thumb/`). Deploys as-is to any static host.

Config is in `data/config.json` (title, currency, `reserveEmail`, and the data
source).

Local-only helper (git-ignored): `tools/optimize-images.py` resizes originals in
`assets/images/` into the `web/` + `thumb/` copies the site serves.
