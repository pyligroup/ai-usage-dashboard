import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function safeStat(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

// Recursively list files under `dir`, optionally filtered by name predicate.
export async function listFilesRecursive(dir, filter = () => true) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await listFilesRecursive(full, filter)));
    } else if (ent.isFile() && filter(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

// Read a JSONL file, returning an array of parsed objects (skipping bad lines).
export async function readJsonlLines(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip malformed line
    }
  }
  return out;
}
