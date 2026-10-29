import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // our OCR runs a Python process: only test/ocr.test.ts turns it on, so the mocked-AI tests stay fast
    env: { SCAN_OCR: "0" },
  },
});
