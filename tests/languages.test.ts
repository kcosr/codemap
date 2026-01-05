import { describe, it, expect } from "vitest";
import {
  detectLanguage,
  canExtractSymbols,
  canExtractStructure,
} from "../src/languages.js";

describe("languages", () => {
  it("detects languages by extension", () => {
    expect(detectLanguage("src/app.ts")).toBe("typescript");
    expect(detectLanguage("src/app.jsx")).toBe("javascript");
    expect(detectLanguage("docs/readme.md")).toBe("markdown");
    expect(detectLanguage("data/file.txt")).toBe("other");
  });

  it("reports supported extraction types", () => {
    expect(canExtractSymbols("typescript")).toBe(true);
    expect(canExtractSymbols("javascript")).toBe(true);
    expect(canExtractSymbols("markdown")).toBe(false);
    expect(canExtractSymbols("other")).toBe(false);

    expect(canExtractStructure("markdown")).toBe(true);
    expect(canExtractStructure("typescript")).toBe(false);
  });
});
