// pi-chatgpt-web — pi extension side.
// /chatgpt <question>: consult the advisor conversation in the user's daily
// browser via the extension↔native-host↔spool bridge, then import question +
// answer into this session without triggering a model call.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { appendOp, pendingOps, markOp, findOp, type Op } from "./state";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SPOOL = path.join(ROOT, "spool");
const RESULT_TIMEOUT_MS = 8 * 60 * 1000;
const HEARTBEAT_STALE_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  fs.writeFileSync(
    path.join(SPOOL, `command-${op.id}.json`),
    JSON.stringify({ id: op.id, type: "ask", mode: op.mode, question }),
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
      "/chatgpt <question> — consult ChatGPT web (advisor) and import Q+A; no args: status; recover: import captured",
    handler: async (args: string, ctx: any) => {
      const a = (args || "").trim();
      if (a === "recover") return recover(pi, ctx);
      if (!a) return showStatus(ctx);
      return runAsk(pi, ctx, a, "advisor");
    },
  });

  pi.registerCommand("tempgpt", {
    description:
      "/tempgpt <question> — ask via a real Temporary Chat and import Q+A (never touches the advisor thread)",
    handler: async (args: string, ctx: any) => {
      const a = (args || "").trim();
      if (a === "recover") return recover(pi, ctx);
      if (!a) return showStatus(ctx);
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
      if (sub === "start") return runAsk(pi, ctx, rest, "side-start");
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
