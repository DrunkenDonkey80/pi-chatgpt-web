#!/usr/bin/env node
// Long-lived native messaging host for pi-chatgpt-web.
// Spawned by the browser when the extension opens its native port. Relays
// spool commands to the extension over the port, writes results + a heartbeat
// back into the spool. Exits when the port closes (browser exit / extension
// disable / reload).
const fs = require("fs");
const path = require("path");

const SPOOL = path.join(__dirname, "..", "spool");
fs.mkdirSync(SPOOL, { recursive: true });

// single leader across browsers: every browser with the extension spawns its
// own host; only the lock holder relays commands + heartbeats, so two open
// browsers never both run the same ask. Standby hosts take over when the
// leader's browser closes (dead pid).
const LOCK = path.join(SPOOL, "host.lock");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
let leader = false;
function isLeader() {
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" });
  } catch {
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(LOCK, "utf8"));
    } catch {}
    if (pid !== process.pid) {
      if (!pid || !alive(pid)) {
        try {
          fs.unlinkSync(LOCK); // stale: claim it on the next tick
        } catch {}
      }
      if (leader) log("lost leadership — standby");
      return (leader = false);
    }
  }
  if (!leader) log(`leader (pid ${process.pid})`);
  return (leader = true);
}
process.on("exit", () => {
  try {
    if (Number(fs.readFileSync(LOCK, "utf8")) === process.pid)
      fs.unlinkSync(LOCK);
  } catch {}
});
process.on("SIGTERM", () => process.exit(0));

// --- stdio framing (Chrome native messaging: 4-byte LE length + JSON) ---
let buf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    let msg;
    try {
      msg = JSON.parse(buf.slice(4, 4 + len).toString("utf8"));
    } catch {
      buf = buf.slice(4 + len);
      continue;
    }
    buf = buf.slice(4 + len);
    onMessage(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

const send = (msg) => {
  try {
    log(`-> ${JSON.stringify(msg).slice(0, 300)}`);
    const b = Buffer.from(JSON.stringify(msg), "utf8");
    const h = Buffer.alloc(4);
    h.writeUInt32LE(b.length, 0);
    process.stdout.write(Buffer.concat([h, b]));
  } catch {}
};

const log = (line) => {
  try {
    fs.appendFileSync(
      path.join(SPOOL, "host.log"),
      `${new Date().toISOString()} ${line}\n`,
    );
  } catch {}
};

const ackedCommands = new Set();

function onMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  log(`<- ${JSON.stringify(msg).slice(0, 300)}`);
  if (msg.type === "pong") return; // keepalive reply
  if (msg.type === "ack" && msg.id) {
    ackedCommands.add(msg.id);
    return;
  }
  if (msg.type === "result" && msg.id) {
    const file = path.join(SPOOL, `result-${msg.id}.json`);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ ts: Date.now(), msg }, null, 2));
    fs.renameSync(tmp, file);
    // ask completed — its command file is no longer needed for crash replay
    try {
      fs.unlinkSync(path.join(SPOOL, `command-${msg.id}.json`));
    } catch {}
    send({ type: "result-ack", id: msg.id });
  }
  // serve staged attachments in 512KB base64 chunks — never arbitrary paths
  if (
    msg.type === "get-file" &&
    msg.id &&
    typeof msg.name === "string" &&
    Number.isInteger(msg.offset)
  ) {
    const file = path.join(SPOOL, `attach-${msg.id}`, path.basename(msg.name));
    try {
      const buf = fs.readFileSync(file);
      const slice = buf.subarray(msg.offset, msg.offset + 512 * 1024);
      send({
        type: "file-chunk",
        reqId: msg.reqId,
        id: msg.id,
        name: msg.name,
        offset: msg.offset,
        size: buf.length,
        data: slice.toString("base64"),
      });
    } catch (e) {
      send({
        type: "file-chunk",
        reqId: msg.reqId,
        error: String((e && e.message) || e),
      });
    }
  }
}

// --- duties ---
// spool poll: relay command files until the extension acks them. The file
// is KEPT until the result lands — if the extension's service worker dies
// mid-ask, Chrome restarts it (and this host), and the fresh host resends
// the still-unresulted command (fresh ackedCommands, fresh extension seen-set).
// ponytail: a crash after send but before result can replay a duplicate
// question; the composer draft-guard usually blocks the double-fill.
setInterval(() => {
  if (!isLeader()) return;
  let files = [];
  try {
    files = fs.readdirSync(SPOOL);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.startsWith("command-") || !f.endsWith(".json")) continue;
    const id = f.slice("command-".length, -".json".length);
    if (ackedCommands.has(id)) continue; // in flight — keep file for crash replay
    try {
      const cmd = JSON.parse(fs.readFileSync(path.join(SPOOL, f), "utf8"));
      send({ ...cmd, type: "command" });
    } catch {}
  }
}, 500);

// heartbeat: pi treats >15s staleness as "bridge down"
setInterval(() => {
  if (!leader) return;
  try {
    fs.writeFileSync(
      path.join(SPOOL, "heartbeat.json"),
      JSON.stringify({ ts: Date.now(), pid: process.pid }),
    );
  } catch {}
}, 3000);

// port keepalive: activity every 20s keeps the MV3 service worker alive
setInterval(() => send({ type: "ping", ts: Date.now() }), 20000);
