// Minimal self-check for handoff + NEED helpers (no framework, plain asserts).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// readRequested()/CFG_FILE resolve against cwd captured at module load — chdir
// FIRST, then import (ESM hoists static imports, so this must be dynamic).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "need-"));
fs.writeFileSync(path.join(tmp, "one.txt"), "AAA");
fs.mkdirSync(path.join(tmp, "sub"));
fs.writeFileSync(path.join(tmp, "sub", "two.txt"), "BBB");
process.chdir(tmp);
process.env.PI_CHATGPT_SETTINGS = path.join(tmp, "settings.json");
process.env.XDG_CONFIG_HOME = path.join(tmp, "runtime-config");
const {
  needRequest,
  readRequested,
  recentTranscript,
  transcriptPairs,
  budgetPairs,
  buildHandoff,
  stageAttachments,
  parseFetch,
  linkArtifacts,
  browserRootsWithExtension,
  defaultBrowserCommand,
  selectDefaultBrowserRoot,
} = await import("../index.ts");

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

// --- session fixture -------------------------------------------------------
// pairs: (first question, first answer) closed by e2; (second question,
// second answer) closed by e4; e5 dangles (user turn, no assistant yet).
const sess = path.join(tmp, "sess.jsonl");
const E = (id, sec, role, content) =>
  JSON.stringify({
    type: "message",
    id,
    timestamp: `2026-09-22T00:00:${sec}.000Z`,
    message: { role, content },
  });
fs.writeFileSync(
  sess,
  [
    JSON.stringify({
      type: "session",
      id: "s1",
      timestamp: "2026-09-22T00:00:00.000Z",
      version: 3,
      cwd: "C:\\t",
    }),
    E("e1", "01", "user", [{ type: "text", text: "first question" }]),
    E("e2", "02", "assistant", [
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "first answer" },
    ]),
    JSON.stringify({
      type: "tool_call",
      id: "t1",
      timestamp: "2026-09-22T00:00:03.000Z",
    }),
    E("e3", "04", "user", [
      { type: "image", data: "xx", mimeType: "image/png" },
      { type: "text", text: "second question" },
    ]),
    E("e4", "05", "assistant", "second answer"),
    E("e5", "06", "user", [{ type: "text", text: "dangling" }]),
    "not json",
  ].join("\n"),
);

const mkCtx = (file, { confirm = async () => true } = {}, notes = []) => ({
  ui: { notify: (m) => notes.push(m), confirm },
  sessionManager: { getSessionFile: () => file },
});
const CFG = path.join(tmp, "settings.json");
const setCfg = (o) => {
  fs.mkdirSync(path.dirname(CFG), { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify(o));
};
const clearCfg = () => fs.rmSync(CFG, { force: true });
clearCfg();

// --- default browser -------------------------------------------------------
assert.deepEqual(defaultBrowserCommand("linux"), {
  command: "xdg-open",
  args: ["https://chatgpt.com/"],
});
assert.deepEqual(defaultBrowserCommand("darwin"), {
  command: "open",
  args: ["-g", "https://chatgpt.com/"],
});
assert.equal(defaultBrowserCommand("win32").args.at(-1), "https://chatgpt.com/");
assert.ok(
  defaultBrowserCommand("win32").args.includes("/min"),
  "win32 browser launch is minimized",
);

const configHome = path.join(tmp, "config");
const browserRoot = path.join(configHome, "vendor", "product");
fs.mkdirSync(path.join(browserRoot, "Default"), { recursive: true });
fs.writeFileSync(path.join(browserRoot, "Local State"), "{}");
fs.writeFileSync(
  path.join(browserRoot, "Default", "Preferences"),
  '{"extensions":{"settings":{"abcdefghijklmnopabcdefghijklmnop":{}}}}',
);
fs.mkdirSync(path.join(configHome, "other", "Default"), { recursive: true });
fs.writeFileSync(path.join(configHome, "other", "Local State"), "{}");
fs.writeFileSync(path.join(configHome, "other", "Default", "Preferences"), "{}");
assert.deepEqual(
  browserRootsWithExtension(configHome, "abcdefghijklmnopabcdefghijklmnop"),
  [browserRoot],
  "native host targets only profiles carrying the extension",
);
assert.equal(
  selectDefaultBrowserRoot(
    ["/config/vendor/first", "/config/vendor/second"],
    "second-browser.desktop",
  ),
  "/config/vendor/second",
);
assert.equal(
  selectDefaultBrowserRoot(["/config/only"], "unknown.desktop"),
  "/config/only",
);

// --- transcriptPairs -------------------------------------------------------
const tp = transcriptPairs(sess);
assert.equal(tp.pairs.length, 2, "two complete pairs");
assert.deepEqual(
  tp.pairs[0],
  {
    user: "first question",
    assistant: "first answer",
    id: "e2",
    ts: Date.parse("2026-09-22T00:00:02.000Z"),
  },
  "pair text + closing id/ts",
);
assert.equal(tp.pairs[1].user, "second question", "img-only content skipped");
assert.equal(tp.pairs[1].assistant, "second answer", "string content works");
assert.ok(!JSON.stringify(tp).includes("hidden"), "thinking skipped");
assert.ok(!JSON.stringify(tp).includes("tool"), "tool entries skipped");
assert.equal(tp.lastId, "e5", "lastId tracks past dangling user turn");
assert.equal(
  tp.lastTs,
  Date.parse("2026-09-22T00:00:06.000Z"),
  "lastTs parsed",
);

const tSince = transcriptPairs(sess, { id: "e2" });
assert.equal(tSince.pairs.length, 1, "cursor keeps only newer pairs");
assert.equal(
  tSince.pairs[0].user,
  "second question",
  "delta is the newer pair",
);

const tLost = transcriptPairs(sess, { id: "zz" });
assert.equal(
  tLost.pairs.length,
  2,
  "unknown cursor falls back to full transcript",
);

const t0 = recentTranscript(mkCtx(sess));
assert.ok(
  t0.includes("first question") && t0.includes("assistant: second answer"),
  "wrapper formats pairs",
);

// --- budgetPairs -----------------------------------------------------------
const P = (n) => ({ user: "u".repeat(n), assistant: "a".repeat(n), id: "x" });
assert.deepEqual(
  budgetPairs([P(200), P(200), P(200)], 1000).length,
  2,
  "tolerance: newest two fit, third dropped",
);
assert.equal(
  budgetPairs([P(100), P(5000)], 1000).length,
  1,
  "newest pair kept even alone over budget",
);
assert.equal(budgetPairs([P(100)], 100)[0].user.length, 100, "normal keep");

// --- buildHandoff: plain ---------------------------------------------------
const notes = [];
const ctx = mkCtx(sess, {}, notes);
const h2 = await buildHandoff(ctx, "where are we?");
assert.ok(h2.q.includes("user: first question"), "transcript included");
assert.ok(h2.q.includes("3-6 bullets"), "no-colon form summarizes generally");
assert.ok(h2.q.endsWith("where are we?"), "no-colon question last");
assert.equal(h2.label, "where are we?", "no-colon label is the whole rest");
assert.deepEqual(
  h2.sentUpTo,
  { id: "e5", ts: Date.parse("2026-09-22T00:00:06.000Z") },
  "advisor cursor proposal covers the whole file",
);

const declined = await buildHandoff(
  mkCtx(sess, { confirm: async () => false }),
  "x: y",
);
assert.equal(declined, null, "user decline aborts send");

const noQ = await buildHandoff(ctx, "");
assert.equal(noQ, null, "empty question rejected");

const tPlain = await buildHandoff(mkCtx(sess), "hi", { mode: "temp" });
assert.equal(tPlain.sentUpTo, undefined, "temp mode never advances cursor");

const seen = [];
const none = await buildHandoff(mkCtx(null, {}, seen), "q");
assert.equal(none.q, "q", "no transcript falls back to bare question");
assert.ok(
  seen.some((m) => /no session transcript/.test(m)),
  "fallback notified",
);

// --- buildHandoff: focused summary (DI summarizer, never spawns pi) --------
const calls = [];
const fakeSum = async (p, m, e) => {
  calls.push([p, m, e]);
  return "SUMMARY";
};
const hF = await buildHandoff(mkCtx(sess), "llm: verdict?", {
  summarizer: fakeSum,
});
assert.ok(hF.q.includes("SUMMARY"), "summary replaces raw transcript");
assert.ok(!hF.q.includes("user: first question"), "no transcript dump");
assert.ok(hF.q.endsWith("verdict?"), "question appended last");
assert.match(calls[0][0], /first question/, "prompt carries the slice");
assert.ok(!/focused on:/.test(calls[0][0]), "llm keyword = no topic");
assert.equal(calls[0][2], "minimal", "default effort passed through");

const hT = await buildHandoff(mkCtx(sess), "the buttons: ok?", {
  summarizer: fakeSum,
});
assert.match(calls[1][0], /focused on: the buttons/, "topic lands in prompt");
assert.ok(hT.q.includes("SUMMARY"), "topic summary used");

const failNotes = [];
const hFall = await buildHandoff(mkCtx(sess, {}, failNotes), "buttons: ok?", {
  summarizer: async () => null,
});
assert.ok(
  hFall.q.includes("user: first question"),
  "failed summarizer falls back to transcript",
);
assert.ok(
  failNotes.some((m) => /local summarizer failed/.test(m)),
  "fallback notified",
);

// --- buildHandoff: cursor (advisor session state) ---------------------------
setCfg({
  handoffMaxChars: 6000,
  summaryModel: "",
  summaryEffort: "low",
  advisors: { [process.cwd()]: { sentUpTo: { id: "e2", ts: 0 } } },
});
const hD = await buildHandoff(mkCtx(sess), "next?");
assert.ok(hD.q.includes("second question"), "delta keeps only new pairs");
assert.ok(!hD.q.includes("first question"), "old pairs not resent");

setCfg({
  handoffMaxChars: 6000,
  summaryModel: "",
  summaryEffort: "low",
  advisors: { [process.cwd()]: { sentUpTo: { id: "e5", ts: 0 } } },
});
const nFresh = [];
const hNone = await buildHandoff(mkCtx(sess, {}, nFresh), "again?");
assert.equal(hNone.q, "again?", "nothing new sends bare question");
assert.ok(
  nFresh.some((m) => /nothing new/.test(m)),
  "nothing-new notified",
);

setCfg({
  handoffMaxChars: 6000,
  summaryModel: "",
  summaryEffort: "low",
  advisors: { [process.cwd()]: { sentUpTo: { id: "zz", ts: 0 } } },
});
const hLost = await buildHandoff(mkCtx(sess), "after compact?");
assert.ok(
  hLost.q.includes("first question"),
  "lost cursor re-sends full transcript",
);
clearCfg();

// --- consult attachments (stageAttachments) -----------------------------
{
  const SPOOL = path.resolve(
    fileURLToPath(import.meta.url),
    "..",
    "..",
    "spool",
  );
  const mk = (n, size) => {
    fs.writeFileSync(path.join(tmp, n), Buffer.alloc(size, 7));
    return n;
  };
  mk("a.png", 1000);
  mk("b.txt", 2000);
  const man = stageAttachments(["a.png", "b.txt"], "att-test-1");
  assert.equal(man.length, 2, "manifest count");
  assert.equal(man[0].name, "a.png");
  assert.equal(man[0].type, "image/png");
  assert.equal(man[1].type, "text/plain");
  assert.ok(
    fs.existsSync(path.join(SPOOL, "attach-att-test-1", "a.png")),
    "staged into spool",
  );
  fs.rmSync(path.join(SPOOL, "attach-att-test-1"), {
    recursive: true,
    force: true,
  });
  mk("1.txt", 10);
  mk("2.txt", 10);
  mk("3.txt", 10);
  mk("4.txt", 10);
  mk("big.bin", 2 * 1024 * 1024 + 1);
  let threw = 0;
  try {
    stageAttachments(["1.txt", "2.txt", "3.txt", "4.txt"], "x");
  } catch {
    threw++;
  }
  try {
    stageAttachments(["big.bin"], "x");
  } catch {
    threw++;
  }
  try {
    stageAttachments(["../../outside.txt"], "x");
  } catch {
    threw++;
  }
  try {
    stageAttachments(["nope.txt"], "x");
  } catch {
    threw++;
  }
  assert.equal(threw, 4, "count/size/sandbox/missing all refused");
}

// --- parseFetch: /chatgpt <url> verb parsing -------------------------------
assert.equal(parseFetch("hello world"), null, "no url -> null");
{
  const [u, v, m] = parseFetch("https://chatgpt.com/c/abc last");
  assert.deepEqual(
    [u, v, m],
    ["https://chatgpt.com/c/abc", "last", ""],
    "bare last",
  );
}
{
  const [, v, m] = parseFetch(
    "https://chatgpt.com/c/abc sum fix the parser now",
  );
  assert.deepEqual([v, m], ["sum", "fix the parser now"], "sum + message");
}
{
  const [, v, m] = parseFetch("https://chatgpt.com/c/abc whatever else");
  assert.deepEqual([v, m], ["ask", "whatever else"], "bare message -> ask");
  const bare = parseFetch("chatgpt.com/c/abc");
  assert.deepEqual(
    [bare[1], bare[2]],
    ["last", ""],
    "bare url -> last",
  );
  const ask = parseFetch(
    "https://chatgpt.com/c/abc get this prompt and make a plan",
  );
  assert.deepEqual(
    [ask[1], ask[2]],
    ["ask", "get this prompt and make a plan"],
    "message kept intact",
  );
}
{
  const [, v, m] = parseFetch("https://chatgpt.com/c/abc HANDOFF  do it");
  assert.deepEqual([v, m], ["handoff", "do it"], "case-insensitive verb");
}
assert.ok(parseFetch("chatgpt.com/c/abc last"), "bare domain accepted");

// --- linkArtifacts: copy staged files, dedupe, link ------------------------
{
  const SPOOL = path.resolve(
    fileURLToPath(import.meta.url),
    "..",
    "..",
    "spool",
  );
  fs.mkdirSync(path.join(SPOOL, "artifacts-t1"), { recursive: true });
  fs.writeFileSync(path.join(SPOOL, "artifacts-t1", "img.png"), "PNGDATA");
  const a1 = linkArtifacts("ans", "t1", [{ name: "img.png" }]);
  assert.ok(a1.includes("[img.png](docs/chatgpt/img.png)"), "link appended");
  assert.ok(
    fs.existsSync(path.join(tmp, "docs", "chatgpt", "img.png")),
    "copied into workspace docs",
  );
  const a2 = linkArtifacts("ans2", "t1", [{ name: "img.png" }]);
  assert.ok(a2.includes("img-2.png"), "dedupe on repeat import");
  const a3 = linkArtifacts("ans3", "nope", [{ name: "x.png" }]);
  assert.ok(a3.includes("failed"), "missing source noted, not fatal");
  assert.ok(
    !fs.existsSync(path.join(tmp, "docs", "chatgpt", "x.png")),
    "failed copy leaves nothing",
  );
  fs.rmSync(path.join(tmp, "docs"), { recursive: true, force: true });
  fs.rmSync(path.join(SPOOL, "artifacts-t1"), { recursive: true, force: true });
}

console.log("handoff + NEED self-check: all assertions passed");
