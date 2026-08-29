/**
 * D8: the agent usually renders mid-loop through its own render_video tool
 * (motion-tools.js:698,729) — both measured runs did. So the wrapper must
 * harvest the newest MP4 from the project's exports rather than assume it
 * will produce the only one, and only render explicitly when none exists.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Newest .mp4 in `dir` by mtime, or null. Never throws — a missing or
 * unreadable exports dir simply means "render it ourselves". */
export function harvestNewestMp4(dir) {
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.mp4'))
      .map((e) => {
        const full = path.join(dir, e.name);
        return { full, mtimeMs: fs.statSync(full).mtimeMs, size: fs.statSync(full).size };
      })
      // A zero-byte MP4 is a crashed encode, not a deliverable.
      .filter((e) => e.size > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries.length ? entries[0].full : null;
  } catch {
    return null;
  }
}
