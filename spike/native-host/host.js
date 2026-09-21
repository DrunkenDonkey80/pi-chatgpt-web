// Native messaging probe host: reads length-prefixed JSON from stdin (Chrome protocol),
// writes the first message to a spool file, echoes a response back.
const fs = require("fs");
const path = require("path");

const SPOOL = path.join(__dirname, "..", "spool");
fs.mkdirSync(SPOOL, { recursive: true });
fs.writeFileSync(
  path.join(SPOOL, "host-started.json"),
  JSON.stringify({ ts: Date.now(), pid: process.pid }),
);

let buf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    let msg;
    try {
      msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
    } catch (e) {
      fs.writeFileSync(
        path.join(SPOOL, "host-received.json"),
        JSON.stringify({ ts: Date.now(), parseError: String(e) }, null, 2),
      );
      buf = buf.subarray(4 + len);
      continue;
    }
    const file =
      msg && msg.type === "m1-result" ? "m1-result.json" : "host-received.json";
    fs.writeFileSync(
      path.join(SPOOL, file),
      JSON.stringify({ ts: Date.now(), msg }, null, 2),
    );
    const resp = Buffer.from(JSON.stringify({ ok: true, echo: msg }));
    const out = Buffer.alloc(4 + resp.length);
    out.writeUInt32LE(resp.length, 0);
    resp.copy(out, 4);
    process.stdout.write(out);
    buf = buf.subarray(4 + len);
  }
});
process.stdin.on("end", () => process.exit(0));
