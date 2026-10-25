# Workstream B: `@dct/extraction`

## Resource limits

All in `CONFIG` (`packages/extraction/src/extract.ts`); render limits are `RENDER_LIMITS` (`src/render.ts`, also exported and reachable as `CONFIG.render`).

| Limit | Default | On exceed |
|---|---|---|
| `render.maxDpi` | 600 | requested DPI clamped (applies to `renderPage` and grid tiles; `EXTRACTION_GRID_DPI` above 600 is clamped) |
| `render.maxPixels` | 40 MP per image | full page downscaled to fit; an oversize tile/clip is rejected (`RangeError`) |
| page number | 1 ≤ page ≤ pageCount, integer | `RangeError` (renderPage gets page numbers from user requests) |
| `render.maxTilesPerPage` | 12 | tile DPI lowered until the page fits; `RangeError` if it can't fit at any DPI |
| `maxPagesPerDoc` | 100 | `ExtractionLimitError` before any rendering or AI call (extract and identify) |
| `maxPagesTotal` | 200 across all documents of a study | `ExtractionLimitError` before any rendering or AI call (extract and identify) |
| `maxTilesPerExtraction` | 60 | tile layout is computed and charged first; `ExtractionLimitError` before that page's pixmaps are allocated |
| `maxImagesPerExtraction` | 300 (classification + term pages + grid overviews + tiles; or one identify call) | `ExtractionLimitError` before the images that would exceed it are rendered |
