import { describe, it, expect } from "vitest";
import { extractMarkdownStructure } from "../src/markdown.js";

describe("extractMarkdownStructure", () => {
  it("extracts headings and code blocks", () => {
    const content = `
# Title

Intro text.

## Usage

\`\`\`ts
const value = 42;
\`\`\`

### Notes

More text.
`;

    const result = extractMarkdownStructure(content);

    expect(result.headings).toEqual([
      { level: 1, text: "Title", line: 2 },
      { level: 2, text: "Usage", line: 6 },
      { level: 3, text: "Notes", line: 12 },
    ]);

    expect(result.codeBlocks).toEqual([
      { language: "ts", startLine: 8, endLine: 10 },
    ]);
  });

  it("ignores headings inside code blocks", () => {
    const content = `
\`\`\`
# Not a heading
\`\`\`

# Real heading
`;

    const result = extractMarkdownStructure(content);
    expect(result.headings).toEqual([
      { level: 1, text: "Real heading", line: 6 },
    ]);
  });
});
