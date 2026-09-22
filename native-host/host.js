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
    send({ type: "result-ack", id: msg.id });
  }
  // serve staged attachments in 512KB base64 chunks — never arbitrary paths
  if (
    msg.type === "get-file" &&
    msg.id &&
    typeof msg.name === "string" &&
    Number.isInteger(msg.offset)
  ) {
    const file = path.join(
      SPOOL,
      `attach-${msg.id}`,
      path.basename(msg.name),
    );
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
// spool poll: relay command files until the extension acks them (idempotent
// resend — the extension dedups by id, so a lost ack self-heals).
setInterval(() => {
  let files = [];
  try {
    files = fs.readdirSync(SPOOL);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.startsWith("command-") || !f.endsWith(".json")) continue;
    const id = f.slice("command-".length, -".json".length);
    if (ackedCommands.has(id)) {
      try {
        fs.unlinkSync(path.join(SPOOL, f));
      } catch {}
      continue;
    }
    try {
      const cmd = JSON.parse(fs.readFileSync(path.join(SPOOL, f), "utf8"));
      send({ ...cmd, type: "command" });
    } catch {}
  }
}, 500);

// heartbeat: pi treats >15s staleness as "bridge down"
setInterval(() => {
  try {
    fs.writeFileSync(
      path.join(SPOOL, "heartbeat.json"),
      JSON.stringify({ ts: Date.now(), pid: process.pid }),
    );
  } catch {}
}, 3000);

// port keepalive: activity every 20s keeps the MV3 service worker alive
setInterval(() => send({ type: "ping", ts: Date.now() }), 20000);
