# Workstream B: `@dct/extraction`

## Resource limits

All in `CONFIG` (`packages/extraction/src/extract.ts`); render limits are `RENDER_LIMITS` (`src/render.ts`, also exported and reachable as `CONFIG.render`).

| Limit | Default | On exceed |
|---|---|---|
| `render.maxDpi` | 600 | requested DPI clamped (applies to `renderPage` and grid tiles; `EXTRACTION_GRID_DPI` above 600 is clamped) |
| `render.maxPixels` | 40 MP per image | full page downscaled to fit; an oversize tile/clip is rejected (`RangeError`) |
| page number | 1 ≤ page ≤ pageCount, integer | `RangeError` (renderPage gets page numbers from user requests) |
| `render.maxTilesPerPage` | 12 | tile DPI lowered until the page fits |
| `maxPagesPerDoc` | 100 | extraction fails with `ExtractionLimitError` before rendering or any AI call |
| `maxTilesPerExtraction` | 60 | extraction fails with `ExtractionLimitError` before any grid AI call |
