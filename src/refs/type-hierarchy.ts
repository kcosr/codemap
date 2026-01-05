import type { CacheDB } from "../cache/db.js";
import type { ReferenceKind } from "../types.js";

export type TypeHierarchyNode = {
  id: number | null;
  name: string;
  kind: string | null;
  path: string | null;
  children: TypeHierarchyNode[];
  circular?: boolean;
};

const HIERARCHY_KINDS: ReferenceKind[] = ["extends", "implements"];

export function buildSubtypeHierarchy(
  db: CacheDB,
  rootId: number,
  maxDepth = 3,
): TypeHierarchyNode {
  return buildNode(db, rootId, 0, maxDepth, new Set(), "in");
}

export function buildSupertypeHierarchy(
  db: CacheDB,
  rootId: number,
  maxDepth = 3,
): TypeHierarchyNode {
  return buildNode(db, rootId, 0, maxDepth, new Set(), "out");
}

export function renderTypeHierarchy(node: TypeHierarchyNode): string {
  const lines: string[] = [];

  const walk = (cur: TypeHierarchyNode, depth: number) => {
    const indent = depth === 0 ? "" : "  ".repeat(depth);
    const prefix = depth === 0 ? "" : "- ";
    const label = formatNodeLabel(cur);
    const suffix = cur.circular ? " (circular ref)" : "";
    lines.push(`${indent}${prefix}${label}${suffix}`);
    for (const child of cur.children) {
      walk(child, depth + 1);
    }
  };

  walk(node, 0);
  return lines.join("\n");
}

function buildNode(
  db: CacheDB,
  symbolId: number,
  depth: number,
  maxDepth: number,
  stack: Set<number>,
  direction: "in" | "out",
): TypeHierarchyNode {
  const symbolRow = db.getSymbolById(symbolId);
  const node: TypeHierarchyNode = {
    id: symbolId,
    name: symbolRow?.name ?? "(unknown)",
    kind: symbolRow?.kind ?? null,
    path: symbolRow?.path ?? null,
    children: [],
  };

  if (stack.has(symbolId)) {
    node.circular = true;
    return node;
  }

  if (depth >= maxDepth) {
    return node;
  }

  stack.add(symbolId);

  const rows = db.listReferenceRows(direction, { symbolId }, HIERARCHY_KINDS);
  const childMap = new Map<string, TypeHierarchyNode>();

  for (const row of rows) {
    const child =
      direction === "out"
        ? buildChildFromOutgoing(db, row, depth, maxDepth, stack)
        : buildChildFromIncoming(db, row, depth, maxDepth, stack);
    if (!child) continue;
    const key = `${child.id ?? "null"}:${child.path ?? ""}:${child.name}:${child.kind ?? ""}`;
    if (!childMap.has(key)) {
      childMap.set(key, child);
    }
  }

  node.children = [...childMap.values()];
  stack.delete(symbolId);
  return node;
}

function buildChildFromOutgoing(
  db: CacheDB,
  row: ReturnType<CacheDB["listReferenceRows"]>[number],
  depth: number,
  maxDepth: number,
  stack: Set<number>,
): TypeHierarchyNode | null {
  const targetId = row.to_symbol_id ?? null;
  const name = row.to_symbol_name;
  const kind = row.to_symbol_kind;
  const path = row.to_path;

  if (!targetId) {
    return { id: null, name, kind, path, children: [] };
  }

  return buildNode(db, targetId, depth + 1, maxDepth, stack, "out");
}

function buildChildFromIncoming(
  db: CacheDB,
  row: ReturnType<CacheDB["listReferenceRows"]>[number],
  depth: number,
  maxDepth: number,
  stack: Set<number>,
): TypeHierarchyNode | null {
  const sourceId = row.from_symbol_id ?? null;
  const name = row.from_symbol_name ?? "(module)";
  const kind = row.from_symbol_kind;
  const path = row.from_path;

  if (!sourceId) {
    return { id: null, name, kind, path, children: [] };
  }

  return buildNode(db, sourceId, depth + 1, maxDepth, stack, "in");
}

function formatNodeLabel(node: TypeHierarchyNode): string {
  const path = node.path ?? "[external]";
  const kind = node.kind ? `${node.kind} ` : "";
  return `${path}:${kind}${node.name}`;
}
