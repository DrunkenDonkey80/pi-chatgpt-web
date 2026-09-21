#!/usr/bin/env node
// Turn the unpacked extension/ into a real installed extension — no developer
// mode, no web store, no server. Packs a signed .crx with a local key, points
// registry "external extension" entries at it, and re-pins the native host
// manifest to the new stable extension ID.
//
//   node install.js           pack + register + re-pin (idempotent, re-runnable)
//   node install.js --remove  unregister only (files stay on disk)
//
// The key (extension.pem) is committed: it fixes the extension ID forever, so
// moving the folder or reinstalling never changes the ID (unlike unpacked).
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const EXT_DIR = path.join(ROOT, "extension");
const CRX = path.join(ROOT, "extension.crx");
const PEM = path.join(ROOT, "extension.pem");
const BROWSER = "C:\\Users\\Flex\\AppData\\Local\\imput\\Helium\\Application\\chrome.exe";
const HOST_MANIFEST = path.join(ROOT, "native-host", "com.flex.pichatgptprobe.json");
const REG_ROOTS = [
  "Software\\Chromium\\Extensions",
  "Software\\Google\\Chrome\\Extensions",
  "Software\\Helium\\Extensions",
];

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`invalid JSON in ${p}: ${e.message}`);
  }
}

const manifest = readJson(path.join(EXT_DIR, "manifest.json"));
const version = manifest.version;

function idFromPem(pemPath) {
  const key = crypto.createPublicKey(fs.readFileSync(pemPath, "utf8"));
  const der = key.export({ type: "spki", format: "der" });
  return [...crypto.createHash("sha256").update(der).digest().slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, ""))
    .join("")
    .split("")
    .map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)))
    .join("");
}

if (process.argv.includes("--remove")) {
  if (!fs.existsSync(PEM)) throw new Error("no extension.pem — cannot derive the ID to remove");
  const id = idFromPem(PEM);
  for (const r of REG_ROOTS) {
    try {
      execFileSync("reg", ["delete", `HKCU\\${r}\\${id}`, "/f"]);
      console.log(`${r}: deleted`);
    } catch {
      console.log(`${r}: not present`);
    }
  }
  console.log("Unregistered. The extension disappears after the next browser restart.");
  process.exit(0);
}

if (!fs.existsSync(BROWSER)) throw new Error(`browser not found: ${BROWSER}`);

// 1. pack (headless chrome packs and exits 0; first run also creates the key)
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "helium-pack-"));
try {
  const args = [
    "--headless=new",
    "--no-first-run",
    `--user-data-dir=${tmpProfile}`,
    `--pack-extension=${EXT_DIR}`,
  ];
  if (fs.existsSync(PEM)) args.push(`--pack-extension-key=${PEM}`);
  execFileSync(BROWSER, args, { stdio: "ignore" });
} finally {
  fs.rmSync(tmpProfile, { recursive: true, force: true });
}
// chrome writes <dir>.crx next to the folder; canonicalize the names
if (fs.existsSync(EXT_DIR + ".crx")) fs.renameSync(EXT_DIR + ".crx", CRX);
if (!fs.existsSync(PEM)) {
  if (!fs.existsSync(EXT_DIR + ".pem"))
    throw new Error("packing produced no key — check chrome path/flags");
  fs.renameSync(EXT_DIR + ".pem", PEM);
}

const id = idFromPem(PEM);
console.log(`packed ${path.basename(CRX)} — extension id: ${id} (version ${version})`);

// 2. register as an external extension (the documented Windows sideload)
for (const r of REG_ROOTS) {
  const key = `HKCU\\${r}\\${id}`;
  execFileSync("reg", ["add", key, "/v", "path", "/t", "REG_SZ", "/d", CRX, "/f"]);
  execFileSync("reg", ["add", key, "/v", "version", "/t", "REG_SZ", "/d", version, "/f"]);
}
console.log("registered as external extension (Chromium / Google\\Chrome / Helium roots)");

// 3. re-pin the native host manifest to the stable ID
const host = readJson(HOST_MANIFEST);
host.allowed_origins = [`chrome-extension://${id}/`];
fs.writeFileSync(HOST_MANIFEST, JSON.stringify(host, null, 2) + "\n");
console.log(`native host pinned to chrome-extension://${id}/`);

console.log(
  "\nNext: fully quit Helium (tray icon too) and relaunch, then check chrome://extensions.\n" +
    "Remove the old unpacked copy if it is still listed. After any manifest change: node install.js again.",
);
