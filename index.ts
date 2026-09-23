// pi-chatgpt-web — pi extension side.
// /chatgpt <question>: consult the advisor conversation in the user's daily
// browser via the extension↔native-host↔spool bridge, then import question +
// answer into this session without triggering a model call.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { appendOp, pendingOps, markOp, findOp, type Op } from "./state.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SPOOL = path.join(ROOT, "spool");

// self-heal: git checkouts/updates don't preserve the exec bit, but on
// non-Windows the native-messaging manifest execs native-host/host.js
// directly (no .bat wrapper) — without +x the browser can't spawn it and
// the bridge silently never comes up (no heartbeat.json, ever).
if (process.platform !== "win32") {
  try {
    fs.chmodSync(path.join(ROOT, "native-host", "host.js"), 0o755);
  } catch {
    // best-effort self-heal: read-only checkout / missing file is non-fatal
  }
}
// Find browser profiles where this extension is actually installed. Native
// host registration supports those profiles; browser selection remains the
// operating system's job.
export function browserRootsWithExtension(
  configHome: string,
  extensionId: string,
): string[] {
  const roots: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (fs.existsSync(path.join(dir, "Local State"))) {
      try {
        const installed = fs.readdirSync(dir, { withFileTypes: true }).some(
          (entry) =>
            entry.isDirectory() &&
            ["Preferences", "Secure Preferences"].some((name) => {
              try {
                return fs
                  .readFileSync(path.join(dir, entry.name, name), "utf8")
                  .includes(extensionId);
              } catch {
                return false;
              }
            }),
        );
        if (installed) roots.push(dir);
      } catch {}
      return;
    }
    if (!depth) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory()) visit(path.join(dir, entry.name), depth - 1);
    } catch {}
  };
  visit(configHome, 2);
  return roots;
}

export function selectDefaultBrowserRoot(
  roots: string[],
  desktopFile: string,
): string | null {
  if (roots.length === 1) return roots[0];
  const ignored = new Set(["browser", "desktop", "stable", "beta", "dev"]);
  const tokens = desktopFile
    .toLowerCase()
    .replace(/\.desktop$/, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !ignored.has(token));
  const scored = roots.map((root) => ({
    root,
    score: tokens.filter((token) => root.toLowerCase().includes(token)).length,
  }));
  const best = Math.max(0, ...scored.map(({ score }) => score));
  const matches = scored.filter(({ score }) => score === best && score > 0);
  return matches.length === 1 ? matches[0].root : null;
}

if (process.platform === "linux") {
  try {
    const src = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "native-host", "com.flex.pichatgptprobe.json"),
        "utf8",
      ),
    );
    const extensionId = String(src.allowed_origins?.[0] ?? "").match(
      /^chrome-extension:\/\/([a-p]{32})\/$/,
    )?.[1];
    if (!extensionId) throw new Error("native host has no extension id");
    const body =
      JSON.stringify(
        { ...src, path: path.join(ROOT, "native-host", "host.js") },
        null,
        2,
      ) + "\n";
    const configHome =
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const roots = browserRootsWithExtension(configHome, extensionId);
    const desktopFile = execFileSync(
      "xdg-settings",
      ["get", "default-web-browser"],
      { encoding: "utf8" },
    ).trim();
    const selected = selectDefaultBrowserRoot(roots, desktopFile);
    if (!selected) throw new Error("could not identify the default browser profile");
    for (const dir of roots) {
      const f = path.join(dir, "NativeMessagingHosts", `${src.name}.json`);
      if (dir !== selected) {
        fs.rmSync(f, { force: true });
        continue;
      }
      let cur = "";
      try {
        cur = fs.readFileSync(f, "utf8");
      } catch {}
      if (cur === body) continue;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    }
  } catch {
    // best-effort: no xdg-settings / unreadable profiles — setup stays manual
  }
}
const RESULT_TIMEOUT_MS = 21 * 60 * 1000; // thinking models: 180s start + 900s generation + settle
const HEARTBEAT_STALE_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CWD = process.cwd();
const NEED_FOOTER =
  "\n\n(Need repo files to answer? Reply with only: NEED: path, path — I'll send them next turn. `NEED: .` lists the tree.)";
const NEED_BUDGET = 64_000;

// ---- user settings (spool/settings.json, /chatgpt setup) --------------------
interface Cfg {
  handoffMaxChars: number; // transcript budget for handoff, default 6000
  summaryModel: string; // "" = current session model
  summaryEffort: string; // "" = model default; else minimal|low|medium|high|xhigh
  advisors: Record<
    string,
    { sentUpTo?: { id: string; ts: number } } | undefined
  >; // per-project advisor state, keyed by workspace dir
}
const SETTINGS =
  process.env.PI_CHATGPT_SETTINGS || path.join(SPOOL, "settings.json");
const CFG_DEFAULTS: Cfg = {
  handoffMaxChars: 6000,
  summaryModel: "",
  summaryEffort: "minimal",
  advisors: {},
};

function loadCfg(): Cfg {
  const c = { ...CFG_DEFAULTS, ...(readJson(SETTINGS) ?? {}) } as Cfg;
  delete (c as any).advisorSentUpTo; // legacy global cursor — meaningless per-project
  delete (c as any).browser; // legacy forced-browser setting
  c.advisors ??= {};
  return c;
}

function saveCfg(c: Cfg) {
  fs.mkdirSync(SPOOL, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(c, null, 2) + "\n");
}

// ---- transcript -> question/answer pairs ------------------------------------
export interface Pair {
  user: string;
  assistant: string;
  id: string;
  ts: number;
}

function entryText(e: any): { role: string; text: string } | null {
  const msg = e.message ?? e;
  if (msg.role !== "user" && msg.role !== "assistant") return null;
  let text = "";
  if (Array.isArray(msg.content))
    text = msg.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  else if (typeof msg.content === "string") text = msg.content;
  text = text.trim();
  return text ? { role: msg.role, text } : null;
}

function entryTs(e: any): number {
  if (typeof e.timestamp === "string") return Date.parse(e.timestamp) || 0;
  if (typeof e.timestamp === "number") return e.timestamp;
  return 0;
}

// complete user+assistant pairs (oldest -> newest); `since` skips everything
// up to and including the cursor entry (by id, falling back to ts).
export function transcriptPairs(
  file: string,
  since?: { id?: string; ts?: number } | null,
): { pairs: Pair[]; lastId: string; lastTs: number } {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let cursorIdx = -1;
  if (since?.id) {
    for (let i = 0; i < lines.length; i++) {
      try {
        if (JSON.parse(lines[i]).id === since.id) {
          cursorIdx = i;
          break;
        }
      } catch {
        /* not json */
      }
    }
  }
  const useTs = !!since && (since.id ? cursorIdx === -1 : true) && !!since.ts;
  const pairs: Pair[] = [];
  let lastId = "";
  let lastTs = 0;
  let pendingUser: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    let e: any;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const ts = entryTs(e);
    if (ts > lastTs) lastTs = ts;
    if (e.id) lastId = e.id;
    if (i <= cursorIdx) {
      if (entryText(e)?.role === "user") pendingUser = null;
      continue;
    }
    if (useTs && ts > 0 && ts <= since!.ts!) continue;
    const t = entryText(e);
    if (!t) continue;
    if (t.role === "user") pendingUser = t.text;
    else {
      pairs.push({
        user: pendingUser ?? "",
        assistant: t.text,
        id: e.id ?? lastId,
        ts: lastTs,
      });
      pendingUser = null;
    }
  }
  return { pairs, lastId, lastTs };
}

// newest-first inclusion with 10% overshoot tolerance; >= 1 pair always kept;
// never cuts inside a message.
export function budgetPairs(pairs: Pair[], max: number): Pair[] {
  const tol = Math.floor(max * 1.1);
  const kept: Pair[] = [];
  let total = 0;
  for (let i = pairs.length - 1; i >= 0; i--) {
    const len = pairs[i].user.length + pairs[i].assistant.length;
    if (kept.length > 0 && total + len > tol) break;
    kept.unshift(pairs[i]);
    total += len;
  }
  return kept;
}

export function formatPairs(pairs: Pair[]): string {
  return pairs
    .map(
      (p) =>
        (p.user ? `user: ${p.user}\n\n` : "") + `assistant: ${p.assistant}`,
    )
    .join("\n\n");
}

// ---- local summarizer: a fresh `pi -p` with the slice embedded ---------------
function piCli(): string {
  try {
    return fileURLToPath(
      import.meta.resolve("@earendil-works/pi-coding-agent/package.json"),
    ).replace(/[\\/]package\.json$/, "/dist/bundle/cli.js");
  } catch {
    return path.join(
      os.homedir(),
      "AppData",
      "Roaming",
      "npm",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    );
  }
}

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

// --- consult attachments: max 3 files, 2MB total, workspace-bounded ---------
export const MAX_ATTACH = 3;
export const MAX_ATTACH_TOTAL = 2 * 1024 * 1024;
const ATTACH_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  ts: "text/plain",
  js: "text/plain",
  mjs: "text/plain",
  css: "text/css",
  html: "text/html",
  py: "text/plain",
  sh: "text/plain",
};

// validate + copy the given workspace files into spool/attach-<opId>/ and
// return the manifest ({name, type}) the extension consumes. The host only
// ever serves this staging dir — never arbitrary paths.
// ponytail: stale attach dirs (>30min) are swept on the next stage, no per-op
// cleanup; ≤2MB each so leftovers are trivial disk
export function stageAttachments(
  files: string[],
  opId: string,
): { name: string; type: string }[] {
  if (!files.length) return [];
  if (files.length > MAX_ATTACH)
    throw new Error(
      `too many attachments: ${files.length} > max ${MAX_ATTACH}`,
    );
  try {
    for (const d of fs.readdirSync(SPOOL)) {
      if (!/^(attach|artifacts)-/.test(d)) continue;
      const p = path.join(SPOOL, d);
      if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60_000)
        fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {}
  const dir = path.join(SPOOL, `attach-${opId}`);
  fs.mkdirSync(dir, { recursive: true });
  const out: { name: string; type: string }[] = [];
  let total = 0;
  for (const p of files) {
    const abs = path.resolve(CWD, p);
    if (abs !== CWD && !abs.startsWith(CWD + path.sep))
      throw new Error(`${p}: refused (outside the workspace)`);
    const stat = fs.statSync(abs); // missing file -> throws, tool surfaces it
    if (stat.isDirectory()) throw new Error(`${p}: is a directory`);
    total += stat.size;
    if (total > MAX_ATTACH_TOTAL)
      throw new Error(
        `attachments exceed ${MAX_ATTACH_TOTAL / 1024 / 1024}MB total`,
      );
    const name = path.basename(abs);
    if (!/^[\w .+()-]+$/.test(name))
      throw new Error(`${p}: unsafe attachment name`);
    fs.copyFileSync(abs, path.join(dir, name));
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    out.push({ name, type: ATTACH_MIME[ext] ?? "application/octet-stream" });
  }
  return out;
}

// copy staged artifacts (spool/artifacts-<opId>/) into the project's
// docs/chatgpt/ and append markdown links to the answer
export function linkArtifacts(
  answer: string,
  opId: string,
  artifacts: { name: string; type?: string }[],
): string {
  if (!Array.isArray(artifacts) || !artifacts.length) return answer;
  const dir = path.join(CWD, "docs", "chatgpt");
  const src = path.join(SPOOL, `artifacts-${opId}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return answer;
  }
  const links: string[] = [];
  for (const a of artifacts) {
    const name = path.basename(String(a?.name || ""));
    if (!/^[\w .+()-]+$/.test(name)) continue;
    let dest = path.join(dir, name);
    let i = 2;
    while (fs.existsSync(dest)) {
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      dest = path.join(dir, `${stem}-${i}${ext}`);
      i++;
    }
    try {
      fs.copyFileSync(path.join(src, name), dest);
      links.push(`[${name}](docs/chatgpt/${path.basename(dest)})`);
    } catch (e: any) {
      links.push(`(${name} failed: ${e?.message || e})`);
    }
  }
  return links.length ? `${answer}\n\n${links.join("\n")}` : answer;
}

// handoff: prepend recent session transcript so the question isn't out of the blue.
export function recentTranscript(ctx: any): string {
  const file = ctx?.sessionManager?.getSessionFile?.();
  if (!file || !fs.existsSync(file)) return "";
  const { pairs } = transcriptPairs(file);
  return formatPairs(budgetPairs(pairs, loadCfg().handoffMaxChars));
}

// "handoff [focus]: question" | "handoff question" -> context + question.
// No focus: budget-cut transcript pairs go out verbatim. A focus (incl. the
// bare keyword "llm") makes a local pi summarize the slice first. Advisor
// mode tracks a send-cursor so only new exchanges go out next time.
export interface HandoffResult {
  q: string;
  label: string;
  sentUpTo?: { id: string; ts: number };
}

export async function buildHandoff(
  ctx: any,
  rest: string,
  opts: {
    mode?: string;
    summarizer?: (
      prompt: string,
      model: string,
      effort: string,
    ) => Promise<string | null>;
  } = {},
): Promise<HandoffResult | null> {
  const colon = rest.indexOf(":");
  const focus = colon === -1 ? "" : rest.slice(0, colon).trim();
  const question = (colon === -1 ? rest : rest.slice(colon + 1)).trim();
  if (!question) {
    ctx.ui.notify("handoff needs a question after it", "error");
    return null;
  }
  const cfg = loadCfg();
  const file = ctx?.sessionManager?.getSessionFile?.();
  const isAdvisor = (opts.mode ?? "advisor") === "advisor";
  const cursor = isAdvisor
    ? (cfg.advisors[process.cwd()]?.sentUpTo ?? null)
    : null;
  const parsed =
    file && fs.existsSync(file)
      ? transcriptPairs(file, cursor)
      : { pairs: [] as Pair[], lastId: "", lastTs: 0 };

  const plain = async (): Promise<HandoffResult | null> => {
    if (!parsed.pairs.length) {
      ctx.ui.notify(
        cursor
          ? "nothing new since the last handoff — sending the question alone"
          : "no session transcript on disk yet — sending the question alone",
        "info",
      );
      return { q: question, label: question };
    }
    const transcript = formatPairs(
      budgetPairs(parsed.pairs, cfg.handoffMaxChars),
    );
    const ok = await ctx.ui.confirm(
      "Send session context?",
      `${transcript.length} chars of recent transcript will be sent to ChatGPT.`,
    );
    if (!ok) return null;
    return {
      q: [
        "Context — recent transcript of my coding session (newest last):",
        "<<<",
        transcript,
        ">>>",
        "",
        focus
          ? `First summarize what matters about: ${focus}.`
          : "First summarize where we are in 3-6 bullets.",
        "Then answer:",
        question,
      ].join("\n"),
      label: question,
      ...(isAdvisor
        ? { sentUpTo: { id: parsed.lastId, ts: parsed.lastTs } }
        : {}),
    };
  };

  if (!focus) return plain();

  // focused summary by a local model; falls back to the transcript variant
  const slice = formatPairs(budgetPairs(parsed.pairs, cfg.handoffMaxChars));
  if (!slice) {
    ctx.ui.notify(
      "nothing to summarize — sending the transcript instead",
      "info",
    );
    return plain();
  }
  const model =
    cfg.summaryModel ||
    (typeof ctx.model === "string" ? ctx.model : ctx.model?.id) ||
    "";
  const topic = focus.toLowerCase() === "llm" ? "" : focus;
  const prompt = `Summarize this coding-session transcript. Output ONLY a compact bullet summary${topic ? ` focused on: ${topic}` : ""}: key decisions, facts, state, open questions. No preamble.\n\n<<<\n${slice}\n>>>`;
  ctx.ui.notify(`summarizing locally${model ? ` with ${model}` : ""}…`, "info");
  const summarizer = opts.summarizer ?? piSummarize;
  const summary = await summarizer(prompt, model, cfg.summaryEffort);
  if (!summary) {
    ctx.ui.notify(
      "local summarizer failed — falling back to full transcript",
      "warning",
    );
    return plain();
  }
  const ok = await ctx.ui.confirm(
    "Send local summary + question?",
    `${summary.length} chars summarized${model ? ` by ${model}` : ""} will be sent to ChatGPT.`,
  );
  if (!ok) return null;
  return {
    q: [
      `Context — summary of my coding session${topic ? ` (focus: ${topic})` : ""}:`,
      "<<<",
      summary,
      ">>>",
      "",
      "Now answer:",
      question,
    ].join("\n"),
    label: question,
    ...(isAdvisor
      ? { sentUpTo: { id: parsed.lastId, ts: parsed.lastTs } }
      : {}),
  };
}

// throwaway pi run: the summarize-only prompt (with the budgeted transcript
// slice inside) rides stdin, the summary comes back on stdout. Isolated from
// this session and bounded by the slice — no --fork, no whole-session replay.
async function piSummarize(
  prompt: string,
  model: string,
  effort: string,
): Promise<string | null> {
  const args: string[] = [piCli(), "-p"];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args);
    let out = "";
    const finish = (v: string | null) => {
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 300_000);
    child.stdout.on("data", (d: Buffer) => {
      out += d;
      if (out.length > 400_000) child.kill();
    });
    child.stderr.on("data", () => {});
    child.on("error", () => finish(null));
    child.on("close", (code: number) =>
      finish(code === 0 && out.trim() ? out.trim() : null),
    );
    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// last failure reason, so machine callers (chatgpt_consult) see WHY instead
// of "check the notifications"
let lastError = "";
function fail(ctx: any, msg: string) {
  lastError = msg;
  ctx.ui.notify(msg, "error");
}

// browser closed = bridge down: open ChatGPT through the operating system's
// default URL handler. The extension connects and the host resumes the spool.
export function defaultBrowserCommand(platform = process.platform): {
  command: string;
  args: string[];
} {
  const url = "https://chatgpt.com/";
  if (platform === "win32")
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/c", "start", "/min", "", url],
    };
  // -g: don't steal focus; /min only helps when the browser starts fresh —
  // a new tab in a running browser still focuses (OS limitation, accepted)
  if (platform === "darwin") return { command: "open", args: ["-g", url] };
  return { command: "xdg-open", args: [url] };
}

let launchedAt = 0;
function launchBrowser(ctx: any) {
  if (Date.now() - launchedAt < 60_000) return; // one attempt per minute
  launchedAt = Date.now();
  const { command, args } = defaultBrowserCommand();
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", (e) =>
      fail(ctx, `could not open the default browser: ${e.message}`),
    );
    child.unref();
    ctx.ui.notify("bridge down, opening the default browser...", "info");
  } catch (e: any) {
    fail(ctx, `could not open the default browser: ${e?.message ?? e}`);
  }
}

async function ensureBridge(ctx: any, signal?: AbortSignal) {
  if (bridgeStatus().up) return true;
  launchBrowser(ctx);
  for (let t0 = Date.now(); Date.now() - t0 < 45_000 && !signal?.aborted; ) {
    await sleep(1000);
    if (bridgeStatus().up) return true;
  }
  return false;
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
  [...s]
    .filter((c) => {
      const cp = c.codePointAt(0)!;
      return (cp >= 32 || cp === 9 || cp === 10 || cp === 13) && cp !== 127;
    })
    .join("");

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
    `Q: ${clean(op.label || op.question)}`,
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
      : "fix: is the default browser running with the pi-chatgpt-web bridge extension enabled?",
    ...pending.map(
      (o) =>
        `pending: [${o.id.slice(0, 8)}] ${o.status} — ${o.question.slice(0, 60)}`,
    ),
  ];
  if (pending.some((o) => o.status === "captured"))
    lines.push(
      "run /chatgpt recover to import captured-but-unimported answers",
    );
  const threads = Object.entries(loadCfg().advisors ?? {});
  if (threads.length)
    lines.push(
      `advisor threads: ${threads
        .map(
          ([ws]) => path.basename(ws) + (ws === process.cwd() ? " (this)" : ""),
        )
        .join(", ")}`,
    );
  lines.push(
    "usage: /chatgpt <q> | handoff <q> | handoff llm: <q> | handoff <topic>: <q>",
    "options: /chatgpt setup",
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
    | "side-new"
    | "fetch-last"
    | "fetch-ask",
  depth = 0,
  opts?: {
    importAs?: string;
    sentUpTo?: { id: string; ts: number };
    returnOnly?: boolean; // machine use: return the answer, don't import it
    files?: string[]; // workspace paths to attach (validated + staged)
    signal?: AbortSignal; // abort (ESC) cancels the wait instead of hanging
    url?: string; // fetch modes: target any conversation by URL
  },
) {
  if (!(await ensureBridge(ctx, opts?.signal))) {
    fail(
      ctx,
      `bridge down (${bridgeStatus().detail}) even after opening the default browser. Is the pi-chatgpt-web bridge extension installed and enabled there?`,
    );
    return;
  }
  const op: Op = {
    id: randomUUID(),
    ts: Date.now(),
    question,
    mode,
    status: "submitted",
    label: opts?.importAs,
  };
  appendOp(op);
  const files = opts?.files?.length
    ? stageAttachments(opts.files, op.id)
    : undefined;
  const wire =
    mode === "advisor" || mode === "temp" || mode === "side-start"
      ? question + NEED_FOOTER
      : question;
  fs.writeFileSync(
    path.join(SPOOL, `command-${op.id}.json`),
    JSON.stringify({
      id: op.id,
      type: "ask",
      mode: op.mode,
      question: wire,
      workspace: process.cwd(),
      files,
      url: opts?.url,
    }),
  );
  // advisor handoff cursor: ChatGPT now has everything up to here — later
  // handoffs send only the delta
  if (opts?.sentUpTo && mode === "advisor") {
    const c = loadCfg();
    const ws = process.cwd();
    c.advisors = {
      ...c.advisors,
      [ws]: { ...c.advisors[ws], sentUpTo: opts.sentUpTo },
    };
    saveCfg(c);
  }
  ctx.ui.notify("sent to ChatGPT — waiting for the answer…", "info");

  const resultFile = path.join(SPOOL, `result-${op.id}.json`);
  const t0 = Date.now();
  for (;;) {
    const r = readJson(resultFile);
    if (r && r.msg) {
      ctx.ui.notify("ChatGPT responded — processing…", "info");
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
              {
                importAs: opts?.importAs ?? question,
                returnOnly: opts?.returnOnly,
                signal: opts?.signal,
              },
            );
          }
          markOp(op.id, {
            status: "imported",
            url: m.url,
            answerChars: (m.answer || "").length,
          });
          const answer =
            Array.isArray(m.artifacts) && m.artifacts.length
              ? linkArtifacts(m.answer || "", op.id, m.artifacts)
              : m.answer || "";
          if (opts?.returnOnly) return { answer, url: m.url };
          importConsultation(pi, op, answer, m.url);
          ctx.ui.notify(`imported ChatGPT answer (${m.url})`, "info");
        }
      } else {
        markOp(op.id, { status: "failed", error: m.error });
        fail(ctx, `ChatGPT consultation failed: ${m.error}`);
      }
      return;
    }
    if (Date.now() - t0 > RESULT_TIMEOUT_MS) {
      markOp(op.id, { status: "needs-attention" });
      fail(
        ctx,
        "timed out waiting for ChatGPT. The tab may still be mid-generation; check the advisor tab, then /chatgpt recover.",
      );
      return;
    }
    // browser closed mid-ask: relaunch; the host replays the kept command file
    if (!bridgeStatus().up) launchBrowser(ctx);
    if (opts?.signal?.aborted) {
      markOp(op.id, { status: "failed", error: "aborted" });
      ctx.ui.notify("consult aborted — waiting cancelled", "info");
      return;
    }
    await sleep(500);
  }
}

// Machine-facing API for other extensions (ce-workflow et al.): ask and get
// the answer back instead of importing it into this session's transcript.
export async function askChatGPT(
  pi: ExtensionAPI,
  ctx: any,
  question: string,
  mode: "advisor" | "temp" = "advisor",
  files?: string[],
): Promise<{ answer: string; url: string } | undefined> {
  return runAsk(pi, ctx, question, mode, 0, { returnOnly: true, files });
}

// modes whose results are importable content; side-start/close/new are control ops
const IMPORT_MODES = new Set([
  "advisor",
  "temp",
  "side-summary",
  "side-last",
  "fetch-last",
  "fetch-ask",
]);

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
      label: existing?.label,
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

// /chatgpt setup — handoff budget, summarizer model/effort, send-cursor
async function setupMenu(ctx: any) {
  const cfg = loadCfg();
  const efforts = ["minimal", "low", "medium", "high", "xhigh"];
  for (;;) {
    const pick = await ctx.ui.select("pi-chatgpt-web setup", [
      `handoff max size: ${cfg.handoffMaxChars} chars`,
      `summary model: ${cfg.summaryModel || "(current session model)"}`,
      `summary effort: ${cfg.summaryEffort || "(model default)"}`,
      "reset advisor handoff cursor",
      "done",
    ]);
    if (!pick || pick === "done") return;
    if (pick.startsWith("handoff max size")) {
      const v = await ctx.ui.input(
        "max transcript chars per handoff",
        String(cfg.handoffMaxChars),
      );
      const n = parseInt((v || "").replace(/[\s,]/g, ""), 10);
      if (n >= 1000 && n <= 200000) {
        cfg.handoffMaxChars = n;
        saveCfg(cfg);
      } else ctx.ui.notify("enter a number between 1000 and 200000", "error");
    } else if (pick.startsWith("summary model")) {
      // scopedModels entries carry a Model object, not a string id
      const mid = (m: any): string =>
        typeof m === "string"
          ? m
          : (m?.id ??
            `${m?.provider ?? "model"}/${m?.modelId ?? m?.name ?? "?"}`);
      const scoped = [
        ...new Set(
          (ctx.scopedModels ?? []).map(
            (s: any) =>
              `${mid(s.model)}${s.thinkingLevel ? `:${s.thinkingLevel}` : ""}`,
          ),
        ),
      ];
      const m = await ctx.ui.select(
        "summary model",
        [...scoped, "(current session model)", "type a model id…", "back"],
        { enableSearch: true } as any,
      );
      if (m === "type a model id…") {
        const t = await ctx.ui.input(
          "model id (provider/id[:thinking])",
          cfg.summaryModel,
        );
        if (t && t.trim()) {
          cfg.summaryModel = t.trim();
          saveCfg(cfg);
        }
      } else if (m === "(current session model)") {
        cfg.summaryModel = "";
        saveCfg(cfg);
      } else if (m && m !== "back") {
        cfg.summaryModel = m;
        saveCfg(cfg);
      }
    } else if (pick.startsWith("summary effort")) {
      const e = await ctx.ui.select("summary effort", [
        "(model default)",
        ...efforts,
      ]);
      if (e) {
        cfg.summaryEffort = e === "(model default)" ? "" : e;
        saveCfg(cfg);
      }
    } else if (pick.startsWith("reset")) {
      if (
        await ctx.ui.confirm(
          "Reset send-cursor?",
          "The next advisor handoff re-sends the full recent transcript.",
        )
      ) {
        delete cfg.advisors[process.cwd()];
        saveCfg(cfg);
        ctx.ui.notify("send-cursor reset for this project", "info");
      }
    }
  }
}

// /chatgpt <url> last|sum|summarize|summary|handoff|all [message] — one-shot
// fetch from any conversation. Unknown (or missing) verb behaves like `last`.
export const FETCH_SUM_WORDS = [
  "sum",
  "summarize",
  "summary",
  "handoff",
  "all",
];
export function parseFetch(a: string): [string, string, string] | null {
  const m = /^(?:https?:\/\/)?chatgpt\.com\/\S+/i.exec(a);
  if (!m) return null;
  const rest = a.slice(m[0].length).trim();
  const w = rest ? rest.split(/\s+/)[0].toLowerCase() : "";
  const msg = w ? rest.slice(w.length).trim() : "";
  if (FETCH_SUM_WORDS.includes(w)) return [m[0], w, msg];
  if (!rest || w === "last") return [m[0], "last", ""];
  // any other text is a follow-up message sent into that conversation
  return [m[0], "ask", rest];
}

export default function (pi: ExtensionAPI) {
  // ChatGPT as an agent: callable by the LLM (this session, subagents, or
  // agents of other extensions) — the answer returns to the caller only.
  pi.registerTool({
    name: "chatgpt_consult",
    label: "Consult ChatGPT",
    description:
      "Ask ChatGPT web (the user's logged-in browser session) a question and return its answer. Advisor mode continues this project's dedicated conversation; files it asks for are sent automatically.",
    promptSnippet: "Consult ChatGPT web as an external advisor",
    promptGuidelines: [
      "Use chatgpt_consult when the user wants ChatGPT's take, a second opinion, or ChatGPT-specific knowledge.",
    ],
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask ChatGPT",
        },
        mode: {
          type: "string",
          enum: ["advisor", "temp"],
          description:
            "advisor (default): continue this project's conversation; temp: one-off Temporary Chat",
        },
        files: {
          type: "array",
          maxItems: 3,
          items: { type: "string" },
          description:
            "Optional workspace paths to attach to the question (max 3, 2MB total). Sent as real file attachments — screenshots, PDFs, source files.",
        },
      },
      required: ["question"],
    } as any,
    async execute(
      _id: string,
      params: any,
      sig: AbortSignal,
      onUpdate: any,
      ctx: any,
    ) {
      onUpdate?.({
        content: [
          { type: "text", text: "asking ChatGPT — this can take a while" },
        ],
      });
      lastError = "";
      const r = await runAsk(
        pi,
        ctx,
        String(params.question),
        params.mode === "temp" ? "temp" : "advisor",
        0,
        {
          returnOnly: true,
          files: Array.isArray(params.files) ? params.files : undefined,
          signal: sig,
        },
      );
      if (!r)
        return {
          content: [
            {
              type: "text",
              text: `ChatGPT consultation failed — ${lastError || "check the session notifications for details."}`,
            },
          ],
          details: {},
        };
      return {
        content: [
          { type: "text", text: `${r.answer}\n\n(conversation: ${r.url})` },
        ],
        details: { url: r.url },
      };
    },
  });
  pi.registerCommand("chatgpt", {
    description:
      "/chatgpt <question> | handoff [focus]: <q> | <url> last|sum [msg] — consult ChatGPT web (advisor) and import Q+A; no args: status; recover: import captured; setup: options",
    handler: async (args: string, ctx: any) => {
      const a = (args || "").trim();
      if (a === "recover") return recover(pi, ctx);
      if (a === "setup") return setupMenu(ctx);
      if (!a) return showStatus(ctx);
      if (/^handoff\b/i.test(a)) {
        const h = await buildHandoff(ctx, a.replace(/^handoff\b/i, "").trim(), {
          mode: "advisor",
        });
        return h
          ? runAsk(pi, ctx, h.q, "advisor", 0, {
              importAs: h.label,
              sentUpTo: h.sentUpTo,
            })
          : undefined;
      }
      const fr = parseFetch(a);
      if (fr) {
        const [url, verb, message] = fr;
        if (verb === "last")
          return runAsk(pi, ctx, "", "fetch-last", 0, { url });
        if (verb === "ask")
          return runAsk(pi, ctx, message, "fetch-ask", 0, { url });
        return runAsk(
          pi,
          ctx,
          `Summarize this conversation as a handoff an agent can resume from — state, decisions, open tasks, next steps.${message ? `\n\nThen address:\n\n${message}` : ""}`,
          "fetch-ask",
          0,
          { url },
        );
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
        const h = await buildHandoff(ctx, a.replace(/^handoff\b/i, "").trim(), {
          mode: "temp",
        });
        return h
          ? runAsk(pi, ctx, h.q, "temp", 0, { importAs: h.label })
          : undefined;
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
          const h = await buildHandoff(
            ctx,
            rest.replace(/^handoff\b/i, "").trim(),
            { mode: "side-start" },
          );
          return h
            ? runAsk(pi, ctx, h.q, "side-start", 0, { importAs: h.label })
            : undefined;
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
