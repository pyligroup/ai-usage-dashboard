import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

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
// Stream line-by-line — Claude session files can be tens of MB; readFile+split
// would hold the whole string + line array in memory at once.
export async function readJsonlLines(file) {
  const out = [];
  let rl;
  try {
    rl = readline.createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
  } catch {
    return out;
  }
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // missing/unreadable file, or mid-read error — return what we have
  } finally {
    rl.close();
  }
  return out;
}
