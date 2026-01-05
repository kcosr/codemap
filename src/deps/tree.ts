import type { CacheDB, ResolvedImportEntry } from "../cache/db.js";

export type DependencyTreeNode = {
  name: string;
  kind: "file" | "external" | "builtin";
  children: DependencyTreeNode[];
  circular?: boolean;
};

type ExternalKind = "external" | "builtin";

function collectExternal(
  imports: ResolvedImportEntry[],
): Map<string, ExternalKind> {
  const externals = new Map<string, ExternalKind>();
  for (const imp of imports) {
    if (imp.is_external !== 1) continue;
    const name = imp.package_name ?? imp.source;
    const kind: ExternalKind = imp.is_builtin === 1 ? "builtin" : "external";
    if (!externals.has(name)) {
      externals.set(name, kind);
    }
  }
  return externals;
}

function buildForwardNode(
  db: CacheDB,
  filePath: string,
  depth: number,
  maxDepth: number,
  stack: Set<string>,
): DependencyTreeNode {
  const node: DependencyTreeNode = {
    name: filePath,
    kind: "file",
    children: [],
  };

  if (depth >= maxDepth) return node;

  const imports = db.getResolvedImports(filePath);
  const internal = new Set<string>();
  for (const imp of imports) {
    if (imp.resolved_path) {
      internal.add(imp.resolved_path);
    }
  }

  const external = collectExternal(imports);
  const internalList = [...internal].sort();
  const externalList = [...external.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  for (const dep of internalList) {
    if (stack.has(dep)) {
      node.children.push({
        name: dep,
        kind: "file",
        children: [],
        circular: true,
      });
      continue;
    }
    const nextStack = new Set(stack);
    nextStack.add(dep);
    node.children.push(buildForwardNode(db, dep, depth + 1, maxDepth, nextStack));
  }

  for (const [name, kind] of externalList) {
    node.children.push({ name, kind, children: [] });
  }

  return node;
}

function buildReverseNode(
  db: CacheDB,
  filePath: string,
  depth: number,
  maxDepth: number,
  stack: Set<string>,
): DependencyTreeNode {
  const node: DependencyTreeNode = {
    name: filePath,
    kind: "file",
    children: [],
  };

  if (depth >= maxDepth) return node;

  const dependents = db.getDependents(filePath).sort();
  for (const importer of dependents) {
    if (stack.has(importer)) {
      node.children.push({
        name: importer,
        kind: "file",
        children: [],
        circular: true,
      });
      continue;
    }
    const nextStack = new Set(stack);
    nextStack.add(importer);
    node.children.push(
      buildReverseNode(db, importer, depth + 1, maxDepth, nextStack),
    );
  }

  return node;
}

export function buildDependencyTree(
  db: CacheDB,
  rootPath: string,
  maxDepth = 10,
): DependencyTreeNode {
  return buildForwardNode(db, rootPath, 0, maxDepth, new Set([rootPath]));
}

export function buildReverseDependencyTree(
  db: CacheDB,
  rootPath: string,
  maxDepth = 10,
): DependencyTreeNode {
  return buildReverseNode(db, rootPath, 0, maxDepth, new Set([rootPath]));
}

export function renderDependencyTree(node: DependencyTreeNode): string {
  const lines: string[] = [];

  const walk = (cur: DependencyTreeNode, depth: number) => {
    const indent = depth === 0 ? "" : "  ".repeat(depth);
    const prefix = depth === 0 ? "" : "- ";
    const label =
      cur.kind === "file" ? cur.name : `[${cur.kind}] ${cur.name}`;
    const suffix = cur.circular ? " (circular ref)" : "";
    lines.push(`${indent}${prefix}${label}${suffix}`);
    for (const child of cur.children) {
      walk(child, depth + 1);
    }
  };

  walk(node, 0);
  return lines.join("\n");
}

function buildDependencyGraph(db: CacheDB): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const path of db.getCachedFiles().keys()) {
    graph.set(path, new Set(db.getDependencies(path)));
  }
  return graph;
}

function canonicalizeCycle(nodes: string[]): string {
  if (nodes.length === 0) return "";
  let minIndex = 0;
  for (let i = 1; i < nodes.length; i += 1) {
    if (nodes[i] < nodes[minIndex]) minIndex = i;
  }
  const rotated = nodes.slice(minIndex).concat(nodes.slice(0, minIndex));
  return rotated.join(" -> ");
}

export function findCircularDependencies(db: CacheDB): string[][] {
  const graph = buildDependencyGraph(db);
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (node: string) => {
    visited.add(node);
    stack.push(node);
    onStack.add(node);

    for (const dep of graph.get(node) ?? []) {
      if (!visited.has(dep)) {
        visit(dep);
        continue;
      }
      if (onStack.has(dep)) {
        const idx = stack.indexOf(dep);
        if (idx >= 0) {
          const cycle = stack.slice(idx).concat(dep);
          const key = canonicalizeCycle(cycle.slice(0, -1));
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(cycle);
          }
        }
      }
    }

    stack.pop();
    onStack.delete(node);
  };

  for (const node of graph.keys()) {
    if (!visited.has(node)) visit(node);
  }

  return cycles;
}
