import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { extractFileSymbols, clearProjectCache } from "../src/symbols.js";

const TIMEOUT = 15000;

describe("extractFileSymbols", () => {
  beforeEach(() => {
    clearProjectCache();
  });

  afterEach(() => {
    clearProjectCache();
  });

  it("extracts functions", { timeout: TIMEOUT }, () => {
    const content = `
export function greet(name: string): string {
  return "Hello, " + name;
}

function privateHelper(): void {}

export async function fetchData(url: string): Promise<Response> {
  return fetch(url);
}
`;
    const result = extractFileSymbols("test.ts", content);

    expect(result.symbols).toHaveLength(3);

    const greet = result.symbols.find((s) => s.name === "greet");
    expect(greet).toBeDefined();
    expect(greet?.kind).toBe("function");
    expect(greet?.exported).toBe(true);
    expect(greet?.isAsync).toBe(false);
    expect(greet?.signature).toContain("name: string");
    expect(greet?.signature).toContain(": string");

    const privateHelper = result.symbols.find(
      (s) => s.name === "privateHelper",
    );
    expect(privateHelper).toBeDefined();
    expect(privateHelper?.exported).toBe(false);

    const fetchData = result.symbols.find((s) => s.name === "fetchData");
    expect(fetchData).toBeDefined();
    expect(fetchData?.isAsync).toBe(true);
  });

  it("extracts classes with members", () => {
    const content = `
export class MyClass {
  private value: number;

  constructor(initial: number) {
    this.value = initial;
  }

  getValue(): number {
    return this.value;
  }

  static create(): MyClass {
    return new MyClass(0);
  }

  async fetchValue(): Promise<number> {
    return this.value;
  }
}
`;
    const result = extractFileSymbols("test.ts", content);

    const cls = result.symbols.find(
      (s) => s.name === "MyClass" && s.kind === "class",
    );
    expect(cls).toBeDefined();
    expect(cls?.exported).toBe(true);

    const children = result.symbols.filter((s) => s.parentName === "MyClass");

    const prop = children.find(
      (s) => s.name === "value" && s.kind === "property",
    );
    expect(prop).toBeDefined();
    expect(prop?.parentName).toBe("MyClass");

    const ctor = children.find((s) => s.kind === "constructor");
    expect(ctor).toBeDefined();
    expect(ctor?.parentName).toBe("MyClass");

    const getValue = children.find((s) => s.name === "getValue");
    expect(getValue).toBeDefined();
    expect(getValue?.kind).toBe("method");
    expect(getValue?.isStatic).toBe(false);

    const createMethod = children.find((s) => s.name === "create");
    expect(createMethod).toBeDefined();
    expect(createMethod?.isStatic).toBe(true);

    const fetchValue = children.find((s) => s.name === "fetchValue");
    expect(fetchValue).toBeDefined();
    expect(fetchValue?.isAsync).toBe(true);
  });

  it("extracts interfaces and types", () => {
    const content = `
export interface User {
  id: number;
  name: string;
}

export type Status = "pending" | "active" | "done";

interface InternalConfig {
  debug: boolean;
}
`;
    const result = extractFileSymbols("test.ts", content);

    const user = result.symbols.find((s) => s.name === "User");
    expect(user).toBeDefined();
    expect(user?.kind).toBe("interface");
    expect(user?.exported).toBe(true);

    const status = result.symbols.find((s) => s.name === "Status");
    expect(status).toBeDefined();
    expect(status?.kind).toBe("type");
    expect(status?.exported).toBe(true);
    expect(status?.signature).toContain("pending");

    const internal = result.symbols.find((s) => s.name === "InternalConfig");
    expect(internal).toBeDefined();
    expect(internal?.exported).toBe(false);
  });

  it("extracts enums", () => {
    const content = `
export enum Color {
  Red = "red",
  Green = "green",
  Blue = "blue"
}
`;
    const result = extractFileSymbols("test.ts", content);

    const colorEnum = result.symbols.find(
      (s) => s.name === "Color" && s.kind === "enum",
    );
    expect(colorEnum).toBeDefined();
    expect(colorEnum?.exported).toBe(true);

    const members = result.symbols.filter((s) => s.parentName === "Color");
    const red = members.find((s) => s.name === "Red");
    expect(red).toBeDefined();
    expect(red?.kind).toBe("enum_member");
    expect(red?.parentName).toBe("Color");
  });

  it("extracts variable declarations", () => {
    const content = `
export const API_URL = "https://api.example.com";

export const handler = async (req: Request): Promise<Response> => {
  return new Response("ok");
};

const privateConst = 42;
`;
    const result = extractFileSymbols("test.ts", content);

    const apiUrl = result.symbols.find((s) => s.name === "API_URL");
    expect(apiUrl).toBeDefined();
    expect(apiUrl?.kind).toBe("variable");
    expect(apiUrl?.exported).toBe(true);

    const handler = result.symbols.find((s) => s.name === "handler");
    expect(handler).toBeDefined();
    expect(handler?.isAsync).toBe(true);

    const privateConst = result.symbols.find((s) => s.name === "privateConst");
    expect(privateConst).toBeDefined();
    expect(privateConst?.exported).toBe(false);
  });

  it("extracts imports", () => {
    const content = `
import fs from "node:fs";
import { join, resolve } from "node:path";
import * as crypto from "node:crypto";
import type { Request } from "express";
import defaultExport, { named } from "./local";
`;
    const result = extractFileSymbols("test.ts", content);

    expect(result.imports.length).toBeGreaterThanOrEqual(5);
    expect(result.imports).toContain("node:fs");
    expect(result.imports).toContain("node:path");
    expect(result.imports).toContain("node:crypto");
    expect(result.imports).toContain("express");
    expect(result.imports).toContain("./local");
  });

  it("marks symbols exported via export lists", () => {
    const content = `
const foo = 1;
const bar = 2;
export { foo, bar as baz };
`;
    const result = extractFileSymbols("test.ts", content);

    const foo = result.symbols.find((s) => s.name === "foo");
    expect(foo).toBeDefined();
    expect(foo?.exported).toBe(true);

    const bar = result.symbols.find((s) => s.name === "bar");
    expect(bar).toBeDefined();
    expect(bar?.exported).toBe(true);
  });

  it("marks symbols exported as default via assignments", () => {
    const content = `
const handler = () => "ok";
export default handler;
`;
    const result = extractFileSymbols("test.ts", content);

    const handler = result.symbols.find((s) => s.name === "handler");
    expect(handler).toBeDefined();
    expect(handler?.exported).toBe(true);
    expect(handler?.isDefault).toBe(true);
  });

  it("extracts JSDoc comments", () => {
    const content = `
/**
 * Greets a user by name.
 * @param name - The user's name
 * @returns A greeting message
 */
export function greet(name: string): string {
  return "Hello, " + name;
}
`;
    const result = extractFileSymbols("test.ts", content);

    const greet = result.symbols.find((s) => s.name === "greet");
    expect(greet).toBeDefined();
    expect(greet?.comment).toBeDefined();
    expect(greet?.comment).toContain("Greets a user by name");
  });

  it("handles JavaScript files", () => {
    const content = `
export function hello(name) {
  return "Hello, " + name;
}

class MyClass {
  constructor(value) {
    this.value = value;
  }
}
`;
    const result = extractFileSymbols("test.js", content);

    const hello = result.symbols.find((s) => s.name === "hello");
    expect(hello).toBeDefined();
    expect(hello?.kind).toBe("function");

    const cls = result.symbols.find((s) => s.name === "MyClass");
    expect(cls).toBeDefined();
    expect(cls?.kind).toBe("class");
  });

  it("handles abstract classes", () => {
    const content = `
export abstract class BaseHandler {
  abstract handle(): void;

  protected log(msg: string): void {
    console.log(msg);
  }
}
`;
    const result = extractFileSymbols("test.ts", content);

    const cls = result.symbols.find(
      (s) => s.name === "BaseHandler" && s.kind === "class",
    );
    expect(cls).toBeDefined();
    expect(cls?.isAbstract).toBe(true);

    const handle = result.symbols.find(
      (s) => s.parentName === "BaseHandler" && s.name === "handle",
    );
    expect(handle).toBeDefined();
    expect(handle?.isAbstract).toBe(true);
  });

  it("handles getters and setters", () => {
    const content = `
class Box {
  private _value: number = 0;

  get value(): number {
    return this._value;
  }

  set value(v: number) {
    this._value = v;
  }
}
`;
    const result = extractFileSymbols("test.ts", content);

    const getter = result.symbols.find(
      (s) => s.parentName === "Box" && s.name === "value" && s.kind === "getter",
    );
    expect(getter).toBeDefined();
    expect(getter?.parentName).toBe("Box");

    const setter = result.symbols.find(
      (s) => s.parentName === "Box" && s.name === "value" && s.kind === "setter",
    );
    expect(setter).toBeDefined();
    expect(setter?.parentName).toBe("Box");
  });
});
