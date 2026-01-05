import path from "node:path";
import type { Language } from "./types.js";

const EXTENSION_MAP: Record<string, Language> = {
  // TypeScript
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",

  // JavaScript
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",

  // Markdown
  ".md": "markdown",
  ".mdx": "markdown",
};

export function detectLanguage(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? "other";
}

export function canExtractSymbols(language: Language): boolean {
  return language === "typescript" || language === "javascript";
}

export function canExtractStructure(language: Language): boolean {
  return language === "markdown";
}
