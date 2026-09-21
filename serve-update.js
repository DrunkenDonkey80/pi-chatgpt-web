#!/usr/bin/env node
// Tiny localhost update server for the enterprise force-install route
// (`node install.js --policy` writes the ExtensionInstallForcelist entry).
// Start it before launching the browser; stop anytime — the installed
// extension stays, only updates need the server running.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const CRX = path.join(ROOT, "extension.crx");
const PEM = path.join(ROOT, "extension.pem");
const PORT = 8642;

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`invalid JSON in ${p}: ${e.message}`);
  }
}

function extId() {
  const key = crypto.createPublicKey(fs.readFileSync(PEM, "utf8"));
  const der = key.export({ type: "spki", format: "der" });
  return [...crypto.createHash("sha256").update(der).digest().slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, ""))
    .join("")
    .split("")
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");
}

http
  .createServer((req, res) => {
    if (req.url.startsWith("/update.xml")) {
      const version = readJson(
        path.join(ROOT, "extension", "manifest.json"),
      ).version;
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">\n` +
          `  <app appid="${extId()}">\n` +
          `    <updatecheck codebase="http://127.0.0.1:${PORT}/extension.crx" version="${version}" />\n` +
          `  </app>\n` +
          `</gupdate>\n`,
      );
    } else if (req.url.startsWith("/extension.crx")) {
      res.writeHead(200, { "Content-Type": "application/x-chrome-extension" });
      res.end(fs.readFileSync(CRX));
    } else {
      res.writeHead(404);
      res.end("no");
    }
  })
  .listen(PORT, "127.0.0.1", () =>
    console.log(
      `update server: http://127.0.0.1:${PORT}/update.xml (appid ${extId()})`,
    ),
  );
