import { describe, it, expect } from "vitest";
import { extractFileSymbols } from "../src/symbols.js";

const TIMEOUT = 20000;

describe("extractFileSymbols (C++)", () => {
  it(
    "extracts namespaces, classes, members, enums, and includes",
    { timeout: TIMEOUT },
    () => {
      const content = `
#include <vector>
#include "parser.hpp"

namespace utils {
  class Parser {
  public:
    Parser();
    bool parse(const std::vector<int>& items) const;
  private:
    int m_count;
  };
}

enum Color { Red, Blue = 2 };
`;

      const result = extractFileSymbols("parser.cpp", content);

      expect(result.imports).toContain("<vector>");
      expect(result.imports).toContain('"parser.hpp"');

      const namespaceSymbol = result.symbols.find(
        (s) => s.kind === "namespace" && s.name === "utils",
      );
      expect(namespaceSymbol).toBeDefined();

      const parserClass = result.symbols.find(
        (s) => s.kind === "class" && s.name === "Parser",
      );
      expect(parserClass).toBeDefined();
      expect(parserClass?.parentName).toBe("utils");

      const constructor = result.symbols.find(
        (s) => s.kind === "constructor" && s.parentName === "utils::Parser",
      );
      expect(constructor).toBeDefined();

      const method = result.symbols.find(
        (s) => s.kind === "method" && s.name === "parse",
      );
      expect(method).toBeDefined();
      expect(method?.parentName).toBe("utils::Parser");

      const field = result.symbols.find(
        (s) => s.kind === "property" && s.name === "m_count",
      );
      expect(field).toBeDefined();
      expect(field?.parentName).toBe("utils::Parser");

      const enumSymbol = result.symbols.find(
        (s) => s.kind === "enum" && s.name === "Color",
      );
      expect(enumSymbol).toBeDefined();

      const enumMember = result.symbols.find(
        (s) => s.kind === "enum_member" && s.name === "Blue",
      );
      expect(enumMember).toBeDefined();
      expect(enumMember?.parentName).toBe("Color");
    },
  );
});
