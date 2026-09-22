// Background service worker: owns the native port, the advisor tab, and the
// one-in-flight guard. Commands arrive over the port (relayed from the spool
// by the native host); results go back the same way.
const HOST = "com.flex.pichatgptprobe";
const ASK_TIMEOUT_MS = 8 * 60 * 1000; // thinking models can take a while

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let port = null;
let busyId = null; // id of the in-flight operation
const results = new Map(); // id -> result, kept until the host acks
const seen = new Set(); // processed command ids (idempotent redelivery)

function connect() {
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // browser may also have killed the service worker; retry when we wake
    setTimeout(connect, 2000);
  });
  for (const r of results.values()) post(r); // replay unsent results
}
connect();

function post(msg) {
  try {
    if (port) port.postMessage(msg);
  } catch {}
}

function onPortMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ping") {
    post({ type: "pong", ts: Date.now() });
    return;
  }
  if (msg.type === "result-ack") {
    results.delete(msg.id);
    return;
  }
  if (msg.type === "command") {
    post({ type: "ack", id: msg.id }); // host deletes the command file
    if (seen.has(msg.id)) {
      // redelivery (lost result-ack or host restart): replay the result
      const r = results.get(msg.id);
      if (r) post(r);
      return;
    }
    seen.add(msg.id);
    handleCommand(msg).catch((e) =>
      sendResult({ id: msg.id, ok: false, error: String(e) }),
    );
  }
}

function sendResult(r) {
  results.set(r.id, r);
  post({ type: "result", ...r });
}

async function handleCommand(cmd) {
  if (busyId) {
    sendResult({
      id: cmd.id,
      ok: false,
      error: "busy: another consultation is in flight",
    });
    return;
  }
  busyId = cmd.id;
  try {
    if (cmd.mode === "temp") {
      // fresh temporary-chat tab per question; closed after the result is spooled
      const tab = await chrome.tabs.create({
        url: "https://chatgpt.com/?temporary-chat=true",
        active: false,
      });
      try {
        await waitForContent(tab.id, 30000);
        const res = await withTimeout(
          chrome.tabs.sendMessage(tab.id, {
            type: "ask",
            id: cmd.id,
            question: cmd.question,
            mode: "temp",
          }),
          ASK_TIMEOUT_MS,
          "temporary chat did not finish in time",
        );
        sendResult({ id: cmd.id, ...res, mode: "temp" });
      } finally {
        try {
          await chrome.tabs.remove(tab.id);
        } catch {}
      }
      return;
    }
    if (cmd.mode && cmd.mode.startsWith("side-")) {
      await sideCommand(cmd);
      return;
    }
    const workspace = cmd.workspace || "default";
    const { tab, fresh } = await getAdvisorTab(workspace);
    let question = cmd.question;
    if (fresh) {
      // brand-new conversation: label it so ChatGPT's auto-title (and the
      // advisor itself) knows which project this thread is about
      const name = workspace.split(/[\\/]/).filter(Boolean).pop() || workspace;
      question = `[project: ${name}]\n\n${question}`;
    }
    const res = await withTimeout(
      chrome.tabs.sendMessage(tab.id, {
        type: "ask",
        id: cmd.id,
        question,
        mode: "advisor",
      }),
      ASK_TIMEOUT_MS,
      "chatgpt tab did not finish in time",
    );
    sendResult({ id: cmd.id, ...res, mode: "advisor" });
    // remember the conversation URL so the thread survives tab/browser restarts
    if (res?.ok && res.url && res.url.includes("/c/")) {
      const { advisors = {} } = await chrome.storage.local.get("advisors");
      advisors[workspace] = { ...(advisors[workspace] || {}), url: res.url };
      await chrome.storage.local.set({ advisors });
    }
  } catch (e) {
    sendResult({
      id: cmd.id,
      ok: false,
      error: String(e && e.message ? e.message : e),
    });
  } finally {
    busyId = null;
  }
}

function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(what);
    }),
  ]);
}

// --- advisor tab lifecycle ---
// One dedicated tab + conversation URL per project workspace; keyed by the
// workspace dir pi sent with the command.
async function getAdvisorTab(workspace) {
  const { advisors = {} } = await chrome.storage.local.get("advisors");
  const rec = advisors[workspace];
  if (rec?.tabId) {
    try {
      const tab = await chrome.tabs.get(rec.tabId);
      if (tab.url && tab.url.startsWith("https://chatgpt.com/")) {
        await waitForContent(tab.id, 0); // already has a content script
        return { tab, fresh: false };
      }
    } catch {}
  }
  // resume the saved conversation if there is one; else a brand-new chat
  const tab = await chrome.tabs.create({
    url: rec?.url || "https://chatgpt.com/",
    active: false,
  });
  await waitForContent(tab.id, 30000);
  advisors[workspace] = { ...rec, tabId: tab.id };
  await chrome.storage.local.set({ advisors });
  return { tab, fresh: !rec?.url };
}

async function waitForContent(tabId, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "ping" });
      return;
    } catch {
      if (Date.now() - t0 > timeoutMs)
        throw new Error("content script not ready in advisor tab");
      await sleep(500);
    }
  }
}

// --- side discussion (M4) ---
// Dedicated tab bound like the advisor tab; conversation URL persisted for
// close-and-resume. The user continues the discussion in the tab by hand;
// pi imports only what the user approves (summary / last exchange).
async function getSideTab(mustExist) {
  const { sideTabId, sideUrl } = await chrome.storage.local.get([
    "sideTabId",
    "sideUrl",
  ]);
  if (sideTabId) {
    try {
      const tab = await chrome.tabs.get(sideTabId);
      if (tab.url && tab.url.startsWith("https://chatgpt.com/")) {
        await waitForContent(tab.id, 0);
        return tab;
      }
    } catch {}
  }
  if (mustExist && !sideUrl)
    throw new Error("no side discussion open — start one with /sidegpt start");
  const tab = await chrome.tabs.create({
    url: sideUrl || "https://chatgpt.com/",
    active: false,
  });
  await waitForContent(tab.id, 30000);
  await chrome.storage.local.set({ sideTabId: tab.id });
  return tab;
}

async function sideCommand(cmd) {
  if (cmd.mode === "side-close" || cmd.mode === "side-new") {
    const { sideTabId } = await chrome.storage.local.get("sideTabId");
    if (sideTabId) {
      try {
        await chrome.tabs.remove(sideTabId);
      } catch {}
    }
    await chrome.storage.local.remove(
      cmd.mode === "side-new" ? ["sideTabId", "sideUrl"] : "sideTabId",
    );
    sendResult({ id: cmd.id, ok: true, mode: cmd.mode });
    return;
  }
  const tab = await getSideTab(cmd.mode !== "side-start");
  const res = await withTimeout(
    chrome.tabs.sendMessage(tab.id, {
      type: "ask",
      id: cmd.id,
      question: cmd.question,
      mode: cmd.mode,
    }),
    ASK_TIMEOUT_MS,
    "side discussion did not finish in time",
  );
  if (res.url) await chrome.storage.local.set({ sideUrl: res.url });
  if (cmd.mode === "side-start")
    await chrome.tabs.update(tab.id, { active: true }); // hand over to the user
  sendResult({ id: cmd.id, ...res, mode: cmd.mode });
}
