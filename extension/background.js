// Background service worker: owns the native port, the advisor tab, and the
// one-in-flight guard. Commands arrive over the port (relayed from the spool
// by the native host); results go back the same way.
const HOST = "com.flex.pichatgptprobe";
const ASK_TIMEOUT_MS = 21 * 60 * 1000; // content waits 180s start + 900s generation + 90s settle

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let port = null;
let busyId = null; // id of the in-flight operation
const results = new Map(); // id -> result, kept until the host acks
const seen = new Set(); // processed command ids (idempotent redelivery)

// MV3 keepalive: a long silent generation gives the service worker nothing
// to do, so Chrome kills it mid-ask — the pending promise, the results map
// and the port all die, and the answer is lost. Any extension API call
// resets the idle timer; ping every 25s while an ask is in flight.
let keepalive = null;
function startKeepalive() {
  if (!keepalive)
    keepalive = setInterval(
      () => chrome.runtime.getPlatformInfo(() => {}),
      25000,
    );
}
function stopKeepalive() {
  clearInterval(keepalive);
  keepalive = null;
}

// attachment pull: the host serves spool/attach-<id>/<name> in 512KB
// base64 chunks; native-port messages must stay under 1MB
const chunkWaiters = new Map(); // reqId -> resolve
async function pullFile(id, name) {
  const parts = [];
  let offset = 0;
  let size = Infinity;
  while (offset < size) {
    const reqId = `${id}:${name}:${offset}`;
    const chunk = await new Promise((resolve, reject) => {
      chunkWaiters.set(reqId, resolve);
      setTimeout(() => {
        if (chunkWaiters.delete(reqId)) reject(new Error("file-chunk timeout"));
      }, 15000);
      post({ type: "get-file", reqId, id, name, offset });
    });
    if (chunk.error) throw new Error(`host get-file: ${chunk.error}`);
    parts.push(Buffer.from(chunk.data, "base64"));
    size = chunk.size;
    offset += parts[parts.length - 1].length;
  }
  return Buffer.concat(parts);
}

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
  if (!port) connect(); // port dropped while we were idle — reconnect
  try {
    if (port) port.postMessage(msg);
  } catch {
    port = null; // zombie port: reconnect on the next post / onDisconnect
  }
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
  if (msg.type === "file-chunk" && msg.reqId) {
    const w = chunkWaiters.get(msg.reqId);
    if (w) {
      chunkWaiters.delete(msg.reqId);
      w(msg);
    }
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
  startKeepalive();
  // pull staged attachments over the port before dispatching the ask
  const attachments = [];
  if (cmd.files?.length) {
    for (const f of cmd.files)
      attachments.push({
        name: f.name,
        type: f.type,
        data: (await pullFile(cmd.id, f.name)).toString("base64"),
      });
  }
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
            attachments,
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
        attachments,
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
    stopKeepalive();
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
  // the saved conversation URL is the durable link: reuse ANY tab already
  // on that conversation — whatever tab is active, whichever window it is
  // in. Never match by tab id alone: tabs drift to other chats.
  if (rec?.url?.includes("/c/")) {
    const path = rec.url.slice("https://chatgpt.com".length);
    const found = (
      await chrome.tabs.query({ url: `*://chatgpt.com${path}*` })
    )[0];
    if (found) {
      try {
        await waitForContent(found.id, 0); // already has a live content script
      } catch {
        // stale/orphaned content script (e.g. tab predates an extension
        // reload): refresh — same conversation URL reloads, new script injects
        await chrome.tabs.reload(found.id);
      }
      await waitForContent(found.id, 30000);
      return { tab: found, fresh: false };
    }
  }
  // no live tab on the conversation: reopen it (ChatGPT restores the
  // thread server-side); only a first-ever ask starts a brand-new chat
  const tab = await chrome.tabs.create({
    url: rec?.url || "https://chatgpt.com/",
    active: false,
  });
  await waitForContent(tab.id, 30000);
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
// One dedicated tab + conversation URL per project workspace (like the
// advisor threads). The user continues the discussion in the tab by hand;
// pi imports only what the user approves (summary / last exchange).
async function getSideTab(workspace, mustExist) {
  const { sides = {} } = await chrome.storage.local.get("sides");
  const rec = sides[workspace];
  if (rec?.tabId) {
    try {
      const tab = await chrome.tabs.get(rec.tabId);
      if (tab.url && tab.url.startsWith("https://chatgpt.com/")) {
        await waitForContent(tab.id, 0);
        return tab;
      }
    } catch {}
  }
  if (mustExist && !rec?.url)
    throw new Error(
      "no side discussion open for this project — start one with /sidegpt start",
    );
  const tab = await chrome.tabs.create({
    url: rec?.url || "https://chatgpt.com/",
    active: false,
  });
  await waitForContent(tab.id, 30000);
  sides[workspace] = { ...rec, tabId: tab.id };
  await chrome.storage.local.set({ sides });
  return tab;
}

async function sideCommand(cmd) {
  const workspace = cmd.workspace || "default";
  if (cmd.mode === "side-close" || cmd.mode === "side-new") {
    const { sides = {} } = await chrome.storage.local.get("sides");
    const rec = sides[workspace];
    if (rec?.tabId) {
      try {
        await chrome.tabs.remove(rec.tabId);
      } catch {}
    }
    if (cmd.mode === "side-new") delete sides[workspace];
    else sides[workspace] = { url: rec?.url }; // close: keep URL to resume
    await chrome.storage.local.set({ sides });
    sendResult({ id: cmd.id, ok: true, mode: cmd.mode });
    return;
  }
  const tab = await getSideTab(workspace, cmd.mode !== "side-start");
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
  if (res.url) {
    const { sides = {} } = await chrome.storage.local.get("sides");
    sides[workspace] = {
      ...(sides[workspace] || {}),
      tabId: tab.id,
      url: res.url,
    };
    await chrome.storage.local.set({ sides });
  }
  if (cmd.mode === "side-start")
    await chrome.tabs.update(tab.id, { active: true }); // hand over to the user
  sendResult({ id: cmd.id, ...res, mode: cmd.mode });
}
