export type IncludeSpec = {
  source: string;
  kind: "system" | "local";
  line: number;
};

const INCLUDE_RE = /^\s*#\s*include\s*(<[^>]+>|"[^"]+")/;

export function extractIncludes(content: string): IncludeSpec[] {
  const lines = content.split(/\r?\n/);
  const includes: IncludeSpec[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(INCLUDE_RE);
    if (!match) continue;

    const raw = match[1];
    if (raw.startsWith("<") && raw.endsWith(">")) {
      includes.push({
        source: raw.slice(1, -1),
        kind: "system",
        line: i + 1,
      });
      continue;
    }

    if (raw.startsWith("\"") && raw.endsWith("\"")) {
      includes.push({
        source: raw.slice(1, -1),
        kind: "local",
        line: i + 1,
      });
    }
  }

  return includes;
}
