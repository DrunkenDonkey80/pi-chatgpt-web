// Minimal self-check for handoff + NEED helpers (no framework, plain asserts).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// readRequested() resolves against cwd captured at module load — chdir FIRST,
// then import (ESM hoists static imports, so this must be dynamic).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "need-"));
fs.writeFileSync(path.join(tmp, "one.txt"), "AAA");
fs.mkdirSync(path.join(tmp, "sub"));
fs.writeFileSync(path.join(tmp, "sub", "two.txt"), "BBB");
process.chdir(tmp);
const { needRequest, readRequested, recentTranscript, buildHandoff } =
  await import("../index.ts");

// --- needRequest -----------------------------------------------------------
assert.equal(
  needRequest("NEED: package.json, README.md") && 0,
  0,
  "plain NEED",
);
assert.deepEqual(
  needRequest("blah\nNEED: a.ts, b.ts\nmore"),
  ["a.ts", "b.ts"],
  "mid-text NEED",
);
assert.deepEqual(needRequest("need: a.ts"), ["a.ts"], "case-insensitive");
assert.deepEqual(needRequest("NEED: ."), ["."], "tree request");
assert.equal(needRequest(""), null, "empty answer");
assert.equal(needRequest("no markers here"), null, "no marker");
assert.equal(needRequest("NEED:   "), null, "marker but no paths");
assert.equal(
  needRequest("NEED: a, a, a, a, a, a, a, a, a, a").length,
  8,
  "capped at 8",
);

// --- readRequested ---------------------------------------------------------
assert.match(readRequested(["one.txt"]), /--- one\.txt ---\nAAA/, "file read");
assert.match(readRequested(["sub"]), /directory/, "dir listed as tree");
assert.match(readRequested(["sub"]), /two\.txt/, "dir listing shows children");
assert.match(readRequested(["nope.txt"]), /not found/, "missing file");
assert.match(readRequested(["../outside.txt"]), /refused/, "escape refused");
assert.match(
  readRequested(["one.txt", "sub/two.txt"]),
  /AAA[\s\S]*BBB/,
  "two files",
);
assert.match(readRequested(["."]), /directory/, "NEED: . gives tree");

// --- recentTranscript / buildHandoff ---------------------------------------
const sess = path.join(tmp, "sess.jsonl");
fs.writeFileSync(
  sess,
  [
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "first question" }],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "first answer" },
        ],
      },
    }),
    JSON.stringify({ type: "message", message: { role: "tool", content: [] } }),
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "image", data: "xx", mimeType: "image/png" },
          { type: "text", text: "second question" },
        ],
      },
    }),
    "not json",
  ].join("\n"),
);
const ctx = {
  ui: { notify: () => {}, confirm: async () => true },
  sessionManager: { getSessionFile: () => sess },
};
const t = recentTranscript(ctx);
assert.ok(
  t.includes("first question") && t.includes("second question"),
  "user turns kept",
);
assert.ok(t.includes("assistant: first answer"), "assistant text kept");
assert.ok(!t.includes("hidden"), "thinking skipped");
assert.ok(!t.includes("tool"), "tool entries skipped");
assert.ok(t.indexOf("first") < t.indexOf("second"), "chronological order");

const h = await buildHandoff(ctx, "the format topic: what do you think?");
assert.ok(h.q.includes("<<<"), "transcript fenced in");
assert.ok(
  h.q.includes("First summarize what matters about: the format topic."),
  "focus honored",
);
assert.ok(h.q.endsWith("what do you think?"), "question appended last");
assert.equal(h.label, "what do you think?", "import label is the short question");
assert.ok(h.label.length < 100, "label stays short");

const h2 = await buildHandoff(ctx, "where are we?");
assert.ok(h2.q.includes("3-6 bullets"), "no-colon form summarizes generally");
assert.ok(h2.q.endsWith("where are we?"), "no-colon question last");
assert.equal(h2.label, "where are we?", "no-colon label is the whole rest");

const declined = await buildHandoff(
  { ...ctx, ui: { notify: () => {}, confirm: async () => false } },
  "x: y",
);
assert.equal(declined, null, "user decline aborts send");

const seen = [];
const none = await buildHandoff(
  {
    ui: { notify: (m) => seen.push(m), confirm: async () => true },
    sessionManager: { getSessionFile: () => null },
  },
  "q",
);
assert.equal(none.q, "q", "no transcript falls back to bare question");
assert.equal(none.label, "q", "fallback label matches");
assert.ok(
  seen.some((m) => /no session transcript/.test(m)),
  "fallback notified",
);

console.log("handoff + NEED self-check: all assertions passed");
