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
    if (cmd.mode === "temp")
      throw new Error("temporary-chat mode arrives in M3");
    const tab = await getAdvisorTab();
    const res = await withTimeout(
      chrome.tabs.sendMessage(tab.id, {
        type: "ask",
        id: cmd.id,
        question: cmd.question,
      }),
      ASK_TIMEOUT_MS,
      "chatgpt tab did not finish in time",
    );
    sendResult({ id: cmd.id, ...res });
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
async function getAdvisorTab() {
  const { advisorTabId } = await chrome.storage.local.get("advisorTabId");
  if (advisorTabId) {
    try {
      const tab = await chrome.tabs.get(advisorTabId);
      if (tab.url && tab.url.startsWith("https://chatgpt.com/")) {
        await waitForContent(tab.id, 0); // already has a content script
        return tab;
      }
    } catch {}
  }
  const tab = await chrome.tabs.create({
    url: "https://chatgpt.com/",
    active: false,
  });
  await waitForContent(tab.id, 30000);
  await chrome.storage.local.set({ advisorTabId: tab.id });
  return tab;
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
