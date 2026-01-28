import type { TagEntry, TagMap } from "./types.js";

export const TAG_KEY_RE = /^[a-z][a-z0-9_-]*$/;

export function parseTag(input: string): TagEntry {
  const trimmed = input.trim();
  const eq = trimmed.indexOf("=");
  if (eq <= 0 || eq === trimmed.length - 1) {
    throw new Error(`Invalid tag "${input}". Expected key=value.`);
  }
  const rawKey = trimmed.slice(0, eq).trim();
  const rawValue = trimmed.slice(eq + 1).trim();
  const key = rawKey.toLowerCase();
  if (!TAG_KEY_RE.test(key)) {
    throw new Error(
      `Invalid tag key "${rawKey}". Expected ${TAG_KEY_RE.source}.`,
    );
  }
  if (rawValue.length === 0) {
    throw new Error(`Invalid tag value for key "${rawKey}".`);
  }
  if (/\s/.test(rawValue)) {
    throw new Error(
      `Invalid tag value "${rawValue}". Whitespace is not allowed.`,
    );
  }
  return { key, value: rawValue };
}

export function formatTag(tag: TagEntry): string {
  return `${tag.key}=${tag.value}`;
}

export function normalizeTagMap(tags?: TagMap): TagMap | undefined {
  if (!tags) return undefined;
  const keys = Object.keys(tags).sort();
  if (keys.length === 0) return undefined;
  const normalized: TagMap = {};
  for (const key of keys) {
    const values = Array.from(new Set(tags[key] ?? [])).sort();
    if (values.length > 0) {
      normalized[key] = values;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function tagMapToList(tags?: TagMap): string[] {
  if (!tags) return [];
  const normalized = normalizeTagMap(tags);
  if (!normalized) return [];
  const result: string[] = [];
  for (const key of Object.keys(normalized)) {
    for (const value of normalized[key]) {
      result.push(`${key}=${value}`);
    }
  }
  return result;
}

export function hasTags(tags?: TagMap): boolean {
  if (!tags) return false;
  return Object.values(tags).some((values) => values.length > 0);
}

export function matchesTags(
  tags: TagMap | undefined,
  filtersAll: TagEntry[] | undefined,
  filtersAny: TagEntry[] | undefined,
): boolean {
  const normalized = normalizeTagMap(tags);
  const all = filtersAll ?? [];
  const any = filtersAny ?? [];

  if (all.length === 0 && any.length === 0) return true;
  if (!normalized) return false;

  const hasTag = (tag: TagEntry): boolean =>
    Array.isArray(normalized[tag.key]) &&
    normalized[tag.key].includes(tag.value);

  if (all.length > 0 && !all.every(hasTag)) {
    return false;
  }

  if (any.length > 0 && !any.some(hasTag)) {
    return false;
  }

  return true;
}

export function summarizeTags(tags?: TagMap): string {
  return tagMapToList(tags).join(", ");
}
