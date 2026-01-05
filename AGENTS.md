# Agent Onboarding (Codemap)

This file is a lightweight, internal onboarding note for agents working in this repo. It is not part of the product output.

## Start Here

- Read `README.md` for the project goal, CLI usage, and API basics.
- Core code lives in `src/`, tests in `tests/`.

## Conventions

- TypeScript, ESM modules, NodeNext resolution (see `tsconfig.json`).
- Keep edits ASCII-only unless a file already uses Unicode.
- Prefer small, focused changes; match existing file layout and naming.

## Testing Requirements

- Run `npm nistall` to install dependencies.
- Run `npm test` for all functional changes.
- Run `npm run build` if you touch the CLI, exports, or public API signatures.
- `npm run build:bun` is optional for local-only binary testing.
- If you cannot run tests, call it out explicitly in your response.
