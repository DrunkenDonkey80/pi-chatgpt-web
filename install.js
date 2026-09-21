#!/usr/bin/env node
// Turn the unpacked extension/ into a real installed extension — no developer
// mode, no web store, no server. Packs a signed .crx with a local key, points
// registry "external extension" entries at it, and re-pins the native host
// manifest to the new stable extension ID.
//
//   node install.js            pack + register + re-pin (idempotent, re-runnable)
//   node install.js --remove    unregister only (files stay on disk)
//   node install.js --policy    enterprise force-install route: writes
//                                ExtensionInstallForcelist pointing at
//                                `node serve-update.js` (works where the plain
//                                registry sideload is ignored, e.g. Chromium 153+)
//   node install.js --policy-remove
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
const BROWSER =
  "C:\\Users\\Flex\\AppData\\Local\\imput\\Helium\\Application\\chrome.exe";
const HOST_MANIFEST = path.join(
  ROOT,
  "native-host",
  "com.flex.pichatgptprobe.json",
);
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
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .split("")
    .map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)))
    .join("");
}

if (
  process.argv.includes("--policy") ||
  process.argv.includes("--policy-remove")
) {
  if (!fs.existsSync(PEM))
    throw new Error("run `node install.js` once first (packs + creates key)");
  const id = idFromPem(PEM);
  const url = `http://127.0.0.1:8642/update.xml`;
  for (const root of [
    "Software\\Policies\\Chromium",
    "Software\\Policies\\Helium",
  ]) {
    const key = `HKCU\\${root}\\ExtensionInstallForcelist`;
    if (process.argv.includes("--policy-remove")) {
      try {
        execFileSync("reg", ["delete", key, "/f"]);
        console.log(`${root}: policy removed`);
      } catch {
        console.log(`${root}: no policy`);
      }
    } else {
      execFileSync("reg", [
        "add",
        key,
        "/v",
        "1",
        "/t",
        "REG_SZ",
        "/d",
        `${id};${url}`,
        "/f",
      ]);
      console.log(`${root}: forcelist ← ${id} @ ${url}`);
    }
  }
  if (process.argv.includes("--policy"))
    console.log(
      "\nNow: start `node serve-update.js`, then fully restart Helium.\n" +
        "The extension installs as forced (no developer mode). The server only needs to run when\n" +
        "the browser starts and the extension is missing or needs an update.",
    );
  process.exit(0);
}

if (process.argv.includes("--remove")) {
  if (!fs.existsSync(PEM))
    throw new Error("no extension.pem — cannot derive the ID to remove");
  const id = idFromPem(PEM);
  for (const r of REG_ROOTS) {
    try {
      execFileSync("reg", ["delete", `HKCU\\${r}\\${id}`, "/f"]);
      console.log(`${r}: deleted`);
    } catch {
      console.log(`${r}: not present`);
    }
  }
  console.log(
    "Unregistered. The extension disappears after the next browser restart.",
  );
  process.exit(0);
}

// after a Web Store publish the ID is Google's, not ours: re-pin the host only
if (process.argv.includes("--id")) {
  const storeId = process.argv[process.argv.indexOf("--id") + 1];
  if (!/^[a-p]{32}$/.test(storeId || ""))
    throw new Error(`not a valid extension ID: ${storeId}`);
  const h = readJson(HOST_MANIFEST);
  h.allowed_origins = [`chrome-extension://${storeId}/`];
  fs.writeFileSync(HOST_MANIFEST, JSON.stringify(h, null, 2) + "\n");
  console.log(`native host pinned to chrome-extension://${storeId}/`);
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

// Chromium 153's packer emits an invalid CRX3 proof signature (installers reject
// with CRX_REQUIRED_PROOF_MISSING); rebuild the header with a correct RSA-SHA256
// proof over the same zip payload. Same key => same ID.
(function fixCrx3Header() {
  const b = fs.readFileSync(CRX);
  const hlen = b.readUInt32LE(8);
  const zip = b.slice(12 + hlen);
  const h = b.slice(12, 12 + hlen);
  const fieldsOf = (buf) => {
    const out = [];
    let i = 0;
    while (i < buf.length) {
      let tag = 0,
        sh = 0,
        more = true;
      while (more) {
        const x = buf[i++];
        tag |= (x & 0x7f) << sh;
        more = x & 0x80;
        sh += 7;
      }
      if ((tag & 7) !== 2) break;
      let len = 0;
      sh = 0;
      more = true;
      while (more) {
        const x = buf[i++];
        len |= (x & 0x7f) << sh;
        more = x & 0x80;
        sh += 7;
      }
      out.push({ field: tag >>> 3, buf: buf.slice(i, i + len) });
      i += len;
    }
    return out;
  };
  const hf = fieldsOf(h);
  const proof = hf.find((f) => f.field === 2)?.buf;
  const sd = hf.find((f) => f.field === 10000)?.buf;
  if (!proof || !sd) throw new Error("unexpected CRX3 header layout");
  const pub = fieldsOf(proof).find((f) => f.field === 1)?.buf;
  const pemPriv = crypto.createPrivateKey(fs.readFileSync(PEM, "utf8"));
  if (
    !crypto
      .createPublicKey(pemPriv)
      .export({ type: "spki", format: "der" })
      .equals(pub)
  )
    throw new Error("pem key does not match the packed proof key");
  const sig = crypto.createSign("RSA-SHA256").update(sd).sign(pemPriv);
  const lv = (n) => {
    const o = [];
    do {
      let x = n & 0x7f;
      n >>>= 7;
      if (n) x |= 0x80;
      o.push(x);
    } while (n);
    return Buffer.from(o);
  };
  const proofBody = Buffer.concat([
    Buffer.from([0x0a]),
    lv(pub.length),
    pub,
    Buffer.from([0x12]),
    lv(sig.length),
    sig,
  ]);
  const header = Buffer.concat([
    Buffer.from([0x12]),
    lv(proofBody.length),
    proofBody,
    Buffer.from([0x82, 0xf1, 0x04]),
    lv(sd.length),
    sd,
  ]);
  const l = Buffer.alloc(4);
  l.writeUInt32LE(header.length);
  fs.writeFileSync(
    CRX,
    Buffer.concat([b.slice(0, 4), Buffer.from([3, 0, 0, 0]), l, header, zip]),
  );
})();

const id = idFromPem(PEM);
console.log(
  `packed ${path.basename(CRX)} — extension id: ${id} (version ${version})`,
);

// 2. register as an external extension (the documented Windows sideload)
for (const r of REG_ROOTS) {
  const key = `HKCU\\${r}\\${id}`;
  execFileSync("reg", [
    "add",
    key,
    "/v",
    "path",
    "/t",
    "REG_SZ",
    "/d",
    CRX,
    "/f",
  ]);
  execFileSync("reg", [
    "add",
    key,
    "/v",
    "version",
    "/t",
    "REG_SZ",
    "/d",
    version,
    "/f",
  ]);
}
console.log(
  "registered as external extension (Chromium / Google\\Chrome / Helium roots)",
);

// 3. re-pin the native host manifest to the stable ID
const host = readJson(HOST_MANIFEST);
host.allowed_origins = [`chrome-extension://${id}/`];
fs.writeFileSync(HOST_MANIFEST, JSON.stringify(host, null, 2) + "\n");
console.log(`native host pinned to chrome-extension://${id}/`);

console.log(
  "\nNext: fully quit Helium (tray icon too) and relaunch, then check chrome://extensions.\n" +
    "Remove the old unpacked copy if it is still listed. After any manifest change: node install.js again.",
);
