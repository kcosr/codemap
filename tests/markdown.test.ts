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
    const totalLines = content.split(/\r?\n/).length;

    expect(result.headings).toEqual([
      { level: 1, text: "Title", line: 2, endLine: totalLines },
      { level: 2, text: "Usage", line: 6, endLine: totalLines },
      { level: 3, text: "Notes", line: 12, endLine: totalLines },
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
    const totalLines = content.split(/\r?\n/).length;
    expect(result.headings).toEqual([
      { level: 1, text: "Real heading", line: 6, endLine: totalLines },
    ]);
  });

  it("assigns heading ranges to the next same or higher level heading", () => {
    const content = [
      "# One",
      "Text",
      "## One A",
      "More",
      "# Two",
      "Text",
      "## Two A",
      "More",
      "## Two B",
      "More",
      "### Two B-1",
      "More",
      "# Three",
    ].join("\n");

    const result = extractMarkdownStructure(content);

    expect(result.headings).toEqual([
      { level: 1, text: "One", line: 1, endLine: 4 },
      { level: 2, text: "One A", line: 3, endLine: 4 },
      { level: 1, text: "Two", line: 5, endLine: 12 },
      { level: 2, text: "Two A", line: 7, endLine: 8 },
      { level: 2, text: "Two B", line: 9, endLine: 12 },
      { level: 3, text: "Two B-1", line: 11, endLine: 12 },
      { level: 1, text: "Three", line: 13, endLine: 13 },
    ]);
  });
});
