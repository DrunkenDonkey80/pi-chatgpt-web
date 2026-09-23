// Browser-worker self-check: attachments need browser APIs, same-thread asks
// serialize, temporary chats run in parallel, and failures release their queue.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../extension/background.js", import.meta.url),
  "utf8",
);
const posted = [];
const asks = [];
const blockedAsks = new Map();
let onPortMessage;
let chunkError = false;

const port = {
  onMessage: { addListener: (fn) => (onPortMessage = fn) },
  onDisconnect: { addListener: () => {} },
  postMessage(msg) {
    posted.push(msg);
    if (msg.type === "get-file")
      queueMicrotask(() =>
        onPortMessage(
          chunkError
            ? { type: "file-chunk", reqId: msg.reqId, error: "boom" }
            : {
                type: "file-chunk",
                reqId: msg.reqId,
                offset: msg.offset,
                size: 5,
                data: btoa(msg.offset ? "cde" : "ab"),
              },
        ),
      );
  },
};

const chrome = {
  runtime: {
    connectNative: () => port,
    getPlatformInfo: () => {},
    onMessage: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
  },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  tabs: {
    create: async () => ({ id: 1, url: "https://chatgpt.com/" }),
    sendMessage: async (_id, msg) => {
      if (msg.type === "ping") return { pong: true };
      asks.push(msg);
      const blocked = msg.question.match(/block:[\w-]+/)?.[0];
      if (blocked)
        await new Promise((resolve) => blockedAsks.set(blocked, resolve));
      return {
        ok: true,
        url: "https://chatgpt.com/c/00000000-0000-0000-0000-000000000000",
        question: msg.question,
        answer: "ok",
      };
    },
    remove: async () => {},
  },
};

const workerTimeout = (...args) => {
  const timer = setTimeout(...args);
  timer.unref();
  return timer;
};
vm.runInNewContext(source, {
  atob,
  btoa,
  chrome,
  clearInterval: () => {},
  clearTimeout,
  console,
  setInterval: () => 1,
  setTimeout: workerTimeout,
});
assert.ok(onPortMessage, "native port listener registered");

const result = async (id) => {
  for (let i = 0; i < 100; i++) {
    const found = posted.find((m) => m.type === "result" && m.id === id);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`no result for ${id}`);
};
const waitBlocked = async (question) => {
  for (let i = 0; i < 100; i++) {
    if (blockedAsks.has(question)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`ask was not dispatched: ${question}`);
};

onPortMessage({
  type: "command",
  id: "attachment-ok",
  mode: "advisor",
  workspace: "/tmp/project",
  question: "hello",
  files: [{ name: "a.txt", type: "text/plain" }],
});
assert.equal((await result("attachment-ok")).ok, true);
assert.equal(atob(asks[0].attachments[0].data), "abcde");

chunkError = true;
onPortMessage({
  type: "command",
  id: "attachment-fails",
  mode: "advisor",
  workspace: "/tmp/project",
  question: "fail",
  files: [{ name: "a.txt", type: "text/plain" }],
});
assert.match((await result("attachment-fails")).error, /host get-file: boom/);

chunkError = false;
onPortMessage({
  type: "command",
  id: "after-failure",
  mode: "advisor",
  workspace: "/tmp/project",
  question: "retry",
});
assert.equal((await result("after-failure")).ok, true, "queue released");

onPortMessage({
  type: "command",
  id: "slow-advisor",
  mode: "advisor",
  workspace: "/tmp/queued",
  question: "block:advisor",
});
await waitBlocked("block:advisor");
onPortMessage({
  type: "command",
  id: "queued-advisor",
  mode: "advisor",
  workspace: "/tmp/queued",
  question: "queued",
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
  asks.some((a) => a.question === "queued"),
  false,
  "same advisor is serialized",
);
blockedAsks.get("block:advisor")();
assert.equal((await result("slow-advisor")).ok, true);
assert.equal((await result("queued-advisor")).ok, true);

onPortMessage({
  type: "command",
  id: "slow-temp",
  mode: "temp",
  question: "block:temp",
});
await waitBlocked("block:temp");
onPortMessage({
  type: "command",
  id: "parallel-temp",
  mode: "temp",
  question: "parallel",
});
assert.equal((await result("parallel-temp")).ok, true, "temp asks run in parallel");
blockedAsks.get("block:temp")();
assert.equal((await result("slow-temp")).ok, true);

console.log("background self-check: all assertions passed");
