# trmnl-vuelta

A [TRMNL](https://usetrmnl.com) private plugin that shows today's La Vuelta a España stage: route, distance, stage type, start time, elevation profile, and a preview of tomorrow's stage. Once the general classification is live, the race leader shows as a small pill in the top-right corner (pre-race, it shows a countdown to the Gran Salida instead).

Forked from the "Tour de France Stages" plugin, pointed at La Vuelta instead of the Tour — La Vuelta runs on the same ASO Race Center platform, so the same fetch/shape logic applies almost unchanged.

![Full layout preview](docs/preview-full.png)

*Live preview via `trmnlp serve`, showing Stage 15 (Palma del Río → Córdoba, 2026 route) pulled from `racecenter.lavuelta.es`.*

## How it works

The plugin uses TRMNL's [polling + serverless transform](https://docs.usetrmnl.com/go/private-plugins/create-a-plugin) strategy. `src/transform.js` is executed by TRMNL itself: it fetches the selected season's stage list, checkpoint, and ranking data from `racecenter.lavuelta.es`, figures out which stage is "today" (before / during / after that season's race), and returns a shaped payload that the Liquid templates in `src/` render.

The **Season** custom field controls which year's data is fetched. It defaults to 2025 since the 2026 Vuelta doesn't start until Aug 22 — until then, switching seasons is the only way to see 2026 pull anything (and even then there's nothing to show before the race starts). Once a season's race has concluded, the plugin naturally settles into showing that season's final classification and last stage as "today."

No separate backend or hosting is required — everything runs inside the TRMNL plugin.

## Layouts

Minimalist, framework-native design (TRMNL design system v3.2.0) — no photos, sparing red accent reserved for climb/KOM and sprint markers in the elevation chart.

- `shared.liquid` — common Liquid logic (stage resolution, stage-type labels, GC/pre-race pill, title bar icon) shared by all four views
- `full.liquid` — full-screen: race-leader/countdown pill, stage hero + stats, elevation profile with schematic route diagram, next-stage preview
- `half_horizontal.liquid` — wide half-screen, single-row strip with a compact elevation chart
- `half_vertical.liquid` — tall half-screen, stacked with a compact elevation + route chart
- `quadrant.liquid` — compact quarter-screen, stage identity only (no chart)

## Local preview

Requires Docker:

```sh
./bin/trmnlp serve
```

Then open `http://localhost:4567` to preview all four layouts against live data.

## Deploying to TRMNL

```sh
gem install trmnl_preview
trmnlp push --id 414982
```

`--id` targets the existing "Vuelta a España Stages" plugin. Omitting it creates a new, disconnected plugin instance instead of updating the live one.

Pushing requires a `TRMNL_API_KEY` (from your TRMNL account) set as the `TRMNL_API_KEY` secret on this repo, or exported in your shell for a manual push. The included GitHub Actions workflow (`.github/workflows/trmnl.yml`) lints on every PR and auto-pushes to TRMNL on merges to `main`.

## Disclaimer

Fan-made. Not affiliated with, endorsed by, or sponsored by ASO or La Vuelta a España.
