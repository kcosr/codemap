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
    expect(detectLanguage("src/lib.rs")).toBe("rust");
    expect(detectLanguage("data/file.txt")).toBe("other");
  });

  it("reports supported extraction types", () => {
    const isBun = typeof (globalThis as any).Bun !== "undefined";

    expect(canExtractSymbols("typescript")).toBe(true);
    expect(canExtractSymbols("javascript")).toBe(true);
    expect(canExtractSymbols("cpp")).toBe(!isBun);
    expect(canExtractSymbols("rust")).toBe(!isBun);
    expect(canExtractSymbols("markdown")).toBe(false);
    expect(canExtractSymbols("other")).toBe(false);

    expect(canExtractStructure("markdown")).toBe(true);
    expect(canExtractStructure("typescript")).toBe(false);
  });
});
