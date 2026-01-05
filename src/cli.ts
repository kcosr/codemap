#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { generateSourceMap } from "./sourceMap.js";
import { renderText, renderJson } from "./render.js";

const cli = yargs(hideBin(process.argv))
  .scriptName("codemap")
  .usage("$0 [patterns...] [options]")
  .positional("patterns", {
    describe: "File glob patterns to include",
    type: "string",
    array: true,
  })
  .option("dir", {
    alias: "C",
    type: "string",
    describe: "Target directory",
    default: process.cwd(),
  })
  .option("output", {
    alias: "o",
    type: "string",
    choices: ["text", "json"] as const,
    default: "text",
    describe: "Output format",
  })
  .option("budget", {
    type: "number",
    describe: "Token budget (auto-reduces detail to fit)",
  })
  .option("exported-only", {
    type: "boolean",
    default: false,
    describe: "Only include exported symbols",
  })
  .option("no-comments", {
    type: "boolean",
    default: false,
    describe: "Exclude JSDoc comments",
  })
  .option("no-imports", {
    type: "boolean",
    default: false,
    describe: "Exclude import lists",
  })
  .option("no-headings", {
    type: "boolean",
    default: false,
    describe: "Exclude markdown headings",
  })
  .option("no-code-blocks", {
    type: "boolean",
    default: false,
    describe: "Exclude markdown code block ranges",
  })
  .option("no-stats", {
    type: "boolean",
    default: false,
    describe: "Exclude project statistics header",
  })
  .option("ignore", {
    type: "string",
    array: true,
    describe: "Ignore patterns (can be repeated)",
  })
  .help()
  .version();

async function main() {
  const argv = await cli.parse();
  const output = argv.output === "json" ? "json" : "text";

  const opts = {
    repoRoot: argv.dir,
    patterns: argv._ as string[],
    ignore: argv.ignore,
    includeComments: !argv["no-comments"],
    includeImports: !argv["no-imports"],
    includeHeadings: !argv["no-headings"],
    includeCodeBlocks: !argv["no-code-blocks"],
    includeStats: !argv["no-stats"],
    exportedOnly: argv["exported-only"],
    tokenBudget: argv.budget,
    output,
  } as const;

  const result = generateSourceMap(opts);

  if (output === "json") {
    console.log(renderJson(result));
  } else {
    console.log(renderText(result, opts));
  }
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
