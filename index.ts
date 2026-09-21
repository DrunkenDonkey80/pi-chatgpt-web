// pi-chatgpt-web — pi extension side.
// /chatgpt <question>: consult the advisor conversation in the user's daily
// browser via the extension↔native-host↔spool bridge, then import question +
// answer into this session without triggering a model call.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { appendOp, pendingOps, markOp, findOp, type Op } from "./state.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SPOOL = path.join(ROOT, "spool");
const RESULT_TIMEOUT_MS = 8 * 60 * 1000;
const HEARTBEAT_STALE_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CWD = process.cwd();
const NEED_FOOTER =
  "\n\n(Need repo files to answer? Reply with only: NEED: path, path — I'll send them next turn. `NEED: .` lists the tree.)";
const NEED_BUDGET = 64_000;
const HANDOFF_CHARS = 6000;

// ChatGPT asked for files: only ever read inside this workspace, bounded.
export function needRequest(answer: string): string[] | null {
  const m = /^\s*NEED:\s*(.+)$/im.exec(answer || "");
  if (!m) return null;
  const paths = m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["'`]+|["'`]+$/g, ""))
    .filter(Boolean)
    .slice(0, 8);
  return paths.length ? paths : null;
}

export function readRequested(paths: string[]): string {
  const out: string[] = [];
  let budget = NEED_BUDGET;
  for (const p of paths) {
    const abs = path.resolve(CWD, p);
    if (abs !== CWD && !abs.startsWith(CWD + path.sep)) {
      out.push(`${p}: refused (outside the workspace)`);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      out.push(`${p}: not found`);
      continue;
    }
    if (stat.isDirectory()) {
      const names = fs
        .readdirSync(abs)
        .filter((n) => n !== "node_modules" && n !== ".git")
        .slice(0, 200);
      out.push(`--- ${p} (directory) ---\n${names.join("\n")}`);
      continue;
    }
    const body = fs.readFileSync(abs, "utf8").slice(0, budget);
    budget -= body.length;
    out.push(`--- ${p} ---\n${body}`);
    if (budget <= 0) {
      out.push("(size budget reached — ask for fewer or smaller files)");
      break;
    }
  }
  return out.join("\n\n");
}

// handoff: prepend recent session transcript so the question isn't out of the blue.
export function recentTranscript(ctx: any): string {
  const file = ctx?.sessionManager?.getSessionFile?.();
  if (!file || !fs.existsSync(file)) return "";
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const parts: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && size < HANDOFF_CHARS; i--) {
    let e: any;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const msg = e.message ?? e;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = Array.isArray(msg.content)
      ? msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
      : typeof msg.content === "string"
        ? msg.content
        : "";
    if (!text.trim()) continue;
    parts.unshift(`${msg.role}: ${text.trim()}`);
    size += text.length;
  }
  return parts.join("\n\n").slice(-HANDOFF_CHARS);
}

// "handoff [focus]: question" | "handoff question" -> a self-summarizing prompt
export async function buildHandoff(ctx: any, rest: string): Promise<string | null> {
  const colon = rest.indexOf(":");
  const focus = colon === -1 ? "" : rest.slice(0, colon).trim();
  const question = (colon === -1 ? rest : rest.slice(colon + 1)).trim();
  if (!question) {
    ctx.ui.notify("handoff needs a question after it", "error");
    return null;
  }
  const transcript = recentTranscript(ctx);
  if (!transcript) {
    ctx.ui.notify(
      "no session transcript on disk yet — sending the question alone",
      "info",
    );
    return question;
  }
  const ok = await ctx.ui.confirm(
    "Send session context?",
    `${transcript.length} chars of recent transcript will be sent to ChatGPT.`,
  );
  if (!ok) return null;
  return [
    "Context — recent transcript of my coding session (truncated, newest last):",
    "<<<",
    transcript,
    ">>>",
    "",
    focus
      ? `First summarize what matters about: ${focus}.`
      : "First summarize where we are in 3-6 bullets.",
    "Then answer:",
    question,
  ].join("\n");
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function bridgeStatus(): { up: boolean; age: number | null; detail: string } {
  const hb = readJson(path.join(SPOOL, "heartbeat.json"));
  if (!hb || typeof hb.ts !== "number")
    return { up: false, age: null, detail: "no heartbeat file" };
  const age = Date.now() - hb.ts;
  return age <= HEARTBEAT_STALE_MS
    ? { up: true, age, detail: `heartbeat ${age}ms old (pid ${hb.pid})` }
    : { up: false, age, detail: `heartbeat stale: ${age}ms old` };
}

const clean = (s: string) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

function importConsultation(
  pi: ExtensionAPI,
  op: Op,
  answer: string,
  url?: string,
) {
  const labels: Record<string, string> = {
    temp: "ChatGPT web consultation (temporary chat)",
    "side-summary": "ChatGPT web side discussion (summary)",
    "side-last": "ChatGPT web side discussion (last exchange)",
  };
  const body = [
    labels[op.mode] || "ChatGPT web consultation (advisor thread)",
    "",
    `Q: ${clean(op.question)}`,
    "",
    "A:",
    clean(answer),
    url ? "" : undefined,
    url ? `(source: ${url})` : undefined,
  ]
    .filter((x) => x !== undefined)
    .join("\n");
  pi.sendMessage(
    {
      customType: "chatgpt-import",
      content: body,
      display: true,
      details: { opId: op.id, url },
    },
    { triggerTurn: false },
  );
}

function showStatus(ctx: any) {
  const st = bridgeStatus();
  const pending = pendingOps();
  const lines = [
    `bridge: ${st.up ? "UP" : "DOWN"} (${st.detail})`,
    st.up
      ? ""
      : "fix: is Helium running with the pi-chatgpt-web bridge extension enabled?",
    ...pending.map(
      (o) =>
        `pending: [${o.id.slice(0, 8)}] ${o.status} — ${o.question.slice(0, 60)}`,
    ),
  ];
  if (pending.some((o) => o.status === "captured"))
    lines.push(
      "run /chatgpt recover to import captured-but-unimported answers",
    );
  ctx.ui.notify(lines.filter(Boolean).join("\n"), "info");
}

async function runAsk(
  pi: ExtensionAPI,
  ctx: any,
  question: string,
  mode:
    | "advisor"
    | "temp"
    | "side-start"
    | "side-summary"
    | "side-last"
    | "side-close"
    | "side-new",
  depth = 0,
) {
  const st = bridgeStatus();
  if (!st.up) {
    ctx.ui.notify(
      `bridge down (${st.detail}). Is Helium running with the bridge extension enabled? Extension moved (new ID)? re-run native-host/regcheck.js`,
      "error",
    );
    return;
  }
  const op: Op = {
    id: randomUUID(),
    ts: Date.now(),
    question,
    mode,
    status: "submitted",
  };
  appendOp(op);
  const wire =
    mode === "advisor" || mode === "temp" || mode === "side-start"
      ? question + NEED_FOOTER
      : question;
  fs.writeFileSync(
    path.join(SPOOL, `command-${op.id}.json`),
    JSON.stringify({ id: op.id, type: "ask", mode: op.mode, question: wire }),
  );
  ctx.ui.notify("sent to ChatGPT — waiting for the answer…", "info");

  const resultFile = path.join(SPOOL, `result-${op.id}.json`);
  const t0 = Date.now();
  for (;;) {
    const r = readJson(resultFile);
    if (r && r.msg) {
      fs.rmSync(resultFile, { force: true });
      const m = r.msg;
      if (m.ok) {
        if (!op.question && m.question) op.question = m.question;
        if (op.mode === "side-start") {
          markOp(op.id, { status: "side-open", url: m.url });
          ctx.ui.notify(
            "side discussion open — the tab is in front; continue the discussion there. /sidegpt summary | last | close when done",
            "info",
          );
        } else if (op.mode === "side-close" || op.mode === "side-new") {
          markOp(op.id, { status: "closed" });
          ctx.ui.notify(
            op.mode === "side-close"
              ? "side tab closed — /sidegpt start resumes the same conversation"
              : "side binding reset — the next start opens a fresh discussion",
            "info",
          );
        } else {
          // advisor only: temp chats can't be continued, so a NEED there is imported as-is
          const need =
            op.mode === "advisor" && depth < 2 ? needRequest(m.answer) : null;
          if (need) {
            markOp(op.id, { status: "imported", url: m.url });
            ctx.ui.notify(
              `ChatGPT asked for: ${need.join(", ")} — sending them`,
              "info",
            );
            return runAsk(
              pi,
              ctx,
              `Files you requested:\n\n${readRequested(need)}`,
              "advisor",
              depth + 1,
            );
          }
          markOp(op.id, {
            status: "imported",
            url: m.url,
            answerChars: (m.answer || "").length,
          });
          importConsultation(pi, op, m.answer, m.url);
          ctx.ui.notify(`imported ChatGPT answer (${m.url})`, "info");
        }
      } else {
        markOp(op.id, { status: "failed", error: m.error });
        ctx.ui.notify(`ChatGPT consultation failed: ${m.error}`, "error");
      }
      return;
    }
    if (Date.now() - t0 > RESULT_TIMEOUT_MS) {
      markOp(op.id, { status: "needs-attention" });
      ctx.ui.notify(
        "timed out waiting for ChatGPT. The tab may still be mid-generation; check the advisor tab, then /chatgpt recover.",
        "error",
      );
      return;
    }
    await sleep(500);
  }
}

// modes whose results are importable content; side-start/close/new are control ops
const IMPORT_MODES = new Set(["advisor", "temp", "side-summary", "side-last"]);

function recover(pi: ExtensionAPI, ctx: any) {
  let found = 0;
  let skipped = 0;
  let files: string[] = [];
  try {
    files = fs.readdirSync(SPOOL);
  } catch {}
  for (const f of files) {
    if (!f.startsWith("result-") || !f.endsWith(".json")) continue;
    const id = f.slice("result-".length, -".json".length);
    const r = readJson(path.join(SPOOL, f));
    if (!r || !r.msg || !r.msg.ok) {
      // failed result: close any needs-attention op, consume the file
      if (r?.msg?.error && findOp(id))
        markOp(id, { status: "failed", error: r.msg.error });
      fs.rmSync(path.join(SPOOL, f), { force: true });
      skipped++;
      continue;
    }
    const mode = r.msg.mode || "advisor";
    if (!IMPORT_MODES.has(mode) || findOp(id)?.status === "imported") {
      // control op or crash-window duplicate: consume, never import
      fs.rmSync(path.join(SPOOL, f), { force: true });
      skipped++;
      continue;
    }
    const existing = findOp(id);
    const op: Op = {
      id,
      ts: r.ts,
      question: r.msg.question || "(unknown)",
      mode,
      status: "imported",
      url: r.msg.url,
    };
    if (existing) markOp(id, { status: "imported", url: r.msg.url });
    else appendOp(op);
    importConsultation(pi, op, r.msg.answer, r.msg.url);
    fs.rmSync(path.join(SPOOL, f), { force: true });
    found++;
  }
  ctx.ui.notify(
    found || skipped
      ? `recovered: ${found} imported, ${skipped} skipped (failed/control/duplicate)`
      : "nothing to recover (no captured results in spool)",
    "info",
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("chatgpt", {
    description:
      "/chatgpt <question> | handoff [focus]: <question> — consult ChatGPT web (advisor) and import Q+A; no args: status; recover: import captured",
    handler: async (args: string, ctx: any) => {
      const a = (args || "").trim();
      if (a === "recover") return recover(pi, ctx);
      if (!a) return showStatus(ctx);
      if (/^handoff\b/i.test(a)) {
        const q = await buildHandoff(ctx, a.replace(/^handoff\b/i, "").trim());
        return q ? runAsk(pi, ctx, q, "advisor") : undefined;
      }
      return runAsk(pi, ctx, a, "advisor");
    },
  });

  pi.registerCommand("tempgpt", {
    description:
      "/tempgpt <question> | handoff [focus]: <question> — ask via a real Temporary Chat and import Q+A (never touches the advisor thread)",
    handler: async (args: string, ctx: any) => {
      const a = (args || "").trim();
      if (a === "recover") return recover(pi, ctx);
      if (!a) return showStatus(ctx);
      if (/^handoff\b/i.test(a)) {
        const q = await buildHandoff(ctx, a.replace(/^handoff\b/i, "").trim());
        return q ? runAsk(pi, ctx, q, "temp") : undefined;
      }
      return runAsk(pi, ctx, a, "temp");
    },
  });

  const SUMMARY_PROMPT =
    "Summarize the whole discussion above as concise bullet points: key decisions, recommendations, and open questions. Skip pleasantries.";

  pi.registerCommand("sidegpt", {
    description:
      "/sidegpt start <q> | summary [focus] | last | close | new — extended side discussion in a browser tab; only summary/last-exchange are imported",
    handler: async (args: string, ctx: any) => {
      const a = (args || "").trim();
      if (!a) return showStatus(ctx);
      const sp = a.indexOf(" ");
      const sub = sp === -1 ? a : a.slice(0, sp);
      const rest = sp === -1 ? "" : a.slice(sp + 1).trim();
      if (sub === "start") {
        if (/^handoff\b/i.test(rest)) {
          const q = await buildHandoff(
            ctx,
            rest.replace(/^handoff\b/i, "").trim(),
          );
          return q ? runAsk(pi, ctx, q, "side-start") : undefined;
        }
        return runAsk(pi, ctx, rest, "side-start");
      }
      if (sub === "summary")
        return runAsk(
          pi,
          ctx,
          SUMMARY_PROMPT + (rest ? ` Focus on: ${rest}` : ""),
          "side-summary",
        );
      if (sub === "last") return runAsk(pi, ctx, "", "side-last");
      if (sub === "close") return runAsk(pi, ctx, "", "side-close");
      if (sub === "new") return runAsk(pi, ctx, "", "side-new");
      ctx.ui.notify(
        `unknown subcommand "${sub}" — use start | summary | last | close | new`,
        "error",
      );
    },
  });
}
