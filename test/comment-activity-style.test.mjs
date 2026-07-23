import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("comment floors use Linear-style cards with the author inside the card", () => {
  assert.match(
    detailSource,
    /<div className="comment-card">\s*<header className="comment-header">\s*<ActorAvatar/s,
  );
  assert.match(styles, /\.comment-entry\s*\{[^}]*display:\s*block;/s);
  assert.doesNotMatch(styles, /\.activity-stream::before/);
  assert.match(
    styles,
    /\.comment-card\s*\{[^}]*background:\s*var\(--surface-muted\);[^}]*box-shadow:\s*none;/s,
  );
});

test("comment composer aligns with the full comment floor width", () => {
  assert.match(styles, /\.comment-composer\s*\{[^}]*margin:\s*18px 8px 0;/s);
});
