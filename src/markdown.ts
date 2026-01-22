import type { MarkdownHeading, MarkdownCodeBlock } from "./types.js";

export type MarkdownStructure = {
  headings: MarkdownHeading[];
  codeBlocks: MarkdownCodeBlock[];
};

type HeadingSeed = Pick<MarkdownHeading, "level" | "text" | "line">;

export function applyHeadingRanges(
  headings: HeadingSeed[],
  totalLines: number,
): MarkdownHeading[] {
  return headings.map((heading, index) => {
    let endLine = totalLines;
    for (let next = index + 1; next < headings.length; next++) {
      if (headings[next].level <= heading.level) {
        endLine = Math.max(heading.line, headings[next].line - 1);
        break;
      }
    }
    return { ...heading, endLine };
  });
}

export function extractMarkdownStructure(content: string): MarkdownStructure {
  const lines = content.split(/\r?\n/);
  const headings: HeadingSeed[] = [];
  const codeBlocks: MarkdownCodeBlock[] = [];

  let inCodeBlock = false;
  let codeBlockStart = 0;
  let codeBlockLang: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockStart = lineNum;
        codeBlockLang = line.slice(3).trim() || null;
      } else {
        codeBlocks.push({
          language: codeBlockLang,
          startLine: codeBlockStart,
          endLine: lineNum,
        });
        inCodeBlock = false;
      }
      continue;
    }

    if (inCodeBlock) continue;

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      headings.push({
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
        line: lineNum,
      });
    }
  }

  const headingsWithRanges = applyHeadingRanges(headings, lines.length);

  return { headings: headingsWithRanges, codeBlocks };
}
