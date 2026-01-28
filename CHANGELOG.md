# Changelog

## [Unreleased]

### Breaking Changes

### Added

### Changed

### Fixed

- Enforced --budget by truncating outline-only file lists and reporting omitted counts. ([#10](https://github.com/kcosr/codemap/pull/10))

### Removed

## [0.1.4] - 2026-01-22

### Added

- Added --stats-only to show summary stats without file entries for pi plugin "dry run" command. ([#9](https://github.com/kcosr/codemap/pull/9))

### Changed

- Markdown headings now include line ranges in output. ([#9](https://github.com/kcosr/codemap/pull/9))
- Updated --no-stats to suppress the token summary footer. ([#9](https://github.com/kcosr/codemap/pull/9))

### Fixed

- Added missing -b flag for --budget

## [0.1.3] - 2026-01-21

### Fixed

- Fixed stats counter bug where `constructor` symbol kind displayed as `constructor: function Object() { [native code] }1` due to inherited Object prototype property. ([#8](https://github.com/kcosr/codemap/pull/8))
- Added documentation about quoting glob patterns to prevent shell expansion. ([#8](https://github.com/kcosr/codemap/pull/8))

## [0.1.2] - 2026-01-18

### Changed

- Pinned `tree-sitter-rust` to `0.23.1` to avoid peer dependency conflicts without legacy install flags. ([#7](https://github.com/kcosr/codemap/pull/7))

## [0.1.1] - 2026-01-18

### Changed

- Downgraded `tree-sitter-rust` to `^0.23.0` to avoid peer dependency conflicts. ([#6](https://github.com/kcosr/codemap/pull/6))

## [0.1.0] - 2026-01-17

### Added

- Rust language support with symbol extraction and basic `use` dependency tracking. ([#5](https://github.com/kcosr/codemap/pull/5))

## [0.0.1] - 2026-01-15

### Added

- C++ support via tree-sitter: symbol extraction (namespaces, classes, structs, methods, fields, enums, typedefs) and `#include` dependency tracking.
- Local include resolution for C++ files in dependency graph (`codemap deps`).
- Release scripts (`scripts/release.mjs`, `scripts/bump-version.mjs`) for automated versioning and changelog management.

## [0.0.0] - 2026-01-15

Initial release tracking. No prior releases recorded.
