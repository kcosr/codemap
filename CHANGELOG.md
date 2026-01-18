# Changelog

## [Unreleased]

### Breaking Changes

### Added

### Changed

### Fixed

### Removed

## [0.1.2] - 2026-01-18

### Breaking Changes

### Added

### Changed

- Pinned `tree-sitter-rust` to `0.23.1` to avoid peer dependency conflicts without legacy install flags. ([#7](https://github.com/kcosr/codemap/pull/7))

### Fixed

### Removed

## [0.1.1] - 2026-01-18

### Breaking Changes

### Added

### Changed

- Downgraded `tree-sitter-rust` to `^0.23.0` to avoid peer dependency conflicts. ([#6](https://github.com/kcosr/codemap/pull/6))

### Fixed

### Removed

## [0.1.0] - 2026-01-17

### Breaking Changes

### Added

- Rust language support with symbol extraction and basic `use` dependency tracking. ([#5](https://github.com/kcosr/codemap/pull/5))

### Changed

### Fixed

### Removed

## [0.0.1] - 2026-01-15

### Breaking Changes

### Added

- C++ support via tree-sitter: symbol extraction (namespaces, classes, structs, methods, fields, enums, typedefs) and `#include` dependency tracking.
- Local include resolution for C++ files in dependency graph (`codemap deps`).
- Release scripts (`scripts/release.mjs`, `scripts/bump-version.mjs`) for automated versioning and changelog management.

### Changed

### Fixed

### Removed

## [0.0.0] - 2026-01-15

Initial release tracking. No prior releases recorded.
