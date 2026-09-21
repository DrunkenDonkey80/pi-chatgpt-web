// Minimal self-check for handoff + NEED helpers (no framework, plain asserts).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// readRequested()/CFG_FILE resolve against cwd captured at module load — chdir
// FIRST, then import (ESM hoists static imports, so this must be dynamic).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "need-"));
fs.writeFileSync(path.join(tmp, "one.txt"), "AAA");
fs.mkdirSync(path.join(tmp, "sub"));
fs.writeFileSync(path.join(tmp, "sub", "two.txt"), "BBB");
process.chdir(tmp);
process.env.PI_CHATGPT_SETTINGS = path.join(tmp, "settings.json");
const {
  needRequest,
  readRequested,
  recentTranscript,
  transcriptPairs,
  budgetPairs,
  buildHandoff,
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
assert.equal(tSince.pairs[0].user, "second question", "delta is the newer pair");

const tLost = transcriptPairs(sess, { id: "zz" });
assert.equal(tLost.pairs.length, 2, "unknown cursor falls back to full transcript");

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
  advisorSentUpTo: { id: "e2", ts: 0 },
});
const hD = await buildHandoff(mkCtx(sess), "next?");
assert.ok(hD.q.includes("second question"), "delta keeps only new pairs");
assert.ok(!hD.q.includes("first question"), "old pairs not resent");

setCfg({ handoffMaxChars: 6000, summaryModel: "", summaryEffort: "low", advisorSentUpTo: { id: "e5", ts: 0 } });
const nFresh = [];
const hNone = await buildHandoff(mkCtx(sess, {}, nFresh), "again?");
assert.equal(hNone.q, "again?", "nothing new sends bare question");
assert.ok(
  nFresh.some((m) => /nothing new/.test(m)),
  "nothing-new notified",
);

setCfg({ handoffMaxChars: 6000, summaryModel: "", summaryEffort: "low", advisorSentUpTo: { id: "zz", ts: 0 } });
const hLost = await buildHandoff(mkCtx(sess), "after compact?");
assert.ok(
  hLost.q.includes("first question"),
  "lost cursor re-sends full transcript",
);
clearCfg();

console.log("handoff + NEED self-check: all assertions passed");
