import { describe, it, expect } from "vitest";
import { extractFileSymbols } from "../src/symbols.js";

const isBun = typeof (globalThis as any).Bun !== "undefined";
const describeRust = isBun ? describe.skip : describe;

describeRust("extractFileSymbols (Rust)", () => {
  it("extracts symbols and use statements", () => {
    const content = `
use std::collections::HashMap;
use crate::utils::{self, format as fmt};
use crate::utils::*;

pub mod utils;

pub const MAX: usize = 100;

pub trait Serialize {
    fn serialize(&self) -> Vec<u8>;
}

pub struct Config {
    pub name: String,
    count: i32,
}

impl Config {
    pub fn new(name: String) -> Self {
        Self { name, count: 0 }
    }

    fn secret(&self) {}
}

pub enum Status {
    Active,
    Inactive,
}

macro_rules! debug {
    ($val:expr) => { println!("{:?}", $val) };
}
`;

    const result = extractFileSymbols("lib.rs", content);

    expect(result.imports).toContain("std::collections::HashMap");
    expect(result.imports).toContain("crate::utils");
    expect(result.imports).toContain("crate::utils::format");
    expect(result.imports).toContain("crate::utils::*");

    expect(
      result.symbols.find(
        (s) => s.kind === "namespace" && s.name === "utils",
      ),
    ).toBeDefined();

    expect(
      result.symbols.find((s) => s.kind === "variable" && s.name === "MAX"),
    ).toBeDefined();

    expect(
      result.symbols.find((s) => s.kind === "trait" && s.name === "Serialize"),
    ).toBeDefined();

    const config = result.symbols.find(
      (s) => s.kind === "struct" && s.name === "Config",
    );
    expect(config).toBeDefined();

    const nameField = result.symbols.find(
      (s) => s.kind === "property" && s.name === "name",
    );
    expect(nameField).toBeDefined();
    expect(nameField?.exported).toBe(true);

    const newMethod = result.symbols.find(
      (s) => s.kind === "method" && s.name === "new",
    );
    expect(newMethod).toBeDefined();
    expect(newMethod?.parentName).toBe("Config");
    expect(newMethod?.exported).toBe(true);

    const secretMethod = result.symbols.find(
      (s) => s.kind === "method" && s.name === "secret",
    );
    expect(secretMethod).toBeDefined();
    expect(secretMethod?.exported).toBe(false);

    expect(
      result.symbols.find((s) => s.kind === "enum" && s.name === "Status"),
    ).toBeDefined();
    expect(
      result.symbols.find(
        (s) => s.kind === "enum_member" && s.name === "Active",
      ),
    ).toBeDefined();

    expect(
      result.symbols.find((s) => s.kind === "macro" && s.name === "debug"),
    ).toBeDefined();
  });

  it("treats pub(crate) as exported and qualifies impl parents", () => {
    const content = `
pub(crate) fn crate_fn() {}
fn private_fn() {}

mod outer {
    pub struct Inner;

    impl Inner {
        pub fn ping(&self) {}
    }
}
`;

    const result = extractFileSymbols("lib.rs", content);

    expect(result.symbols.find((s) => s.name === "crate_fn")?.exported).toBe(
      true,
    );
    expect(result.symbols.find((s) => s.name === "private_fn")?.exported).toBe(
      false,
    );

    const ping = result.symbols.find(
      (s) => s.kind === "method" && s.name === "ping",
    );
    expect(ping).toBeDefined();
    expect(ping?.parentName).toBe("outer::Inner");
  });
});
