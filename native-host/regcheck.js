// Query/fix native-messaging host registry entries for compatible browsers.
// Safe to re-run anytime; runtime browser selection stays with the OS default.
// `node regcheck.js --remove` deletes the entries (full disable; the host
// manifest and files stay on disk).
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const HOST = "com.flex.pichatgptprobe";
const SOURCE_MANIFEST = path.join(__dirname, `${HOST}.json`);
const RUNTIME_DIR = path.join(
  process.env.LOCALAPPDATA || __dirname,
  "pi-chatgpt-web",
);
const MANIFEST = path.join(RUNTIME_DIR, `${HOST}.json`);
const LAUNCHER = path.join(RUNTIME_DIR, "host.bat");
const roots = [
  "Software\\Chromium",
  "Software\\Google\\Chrome",
  "Software\\Microsoft\\Edge",
  "Software\\Helium",
  "Software\\imput\\Helium",
];

if (!process.argv.includes("--remove")) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(SOURCE_MANIFEST, "utf8"));
  } catch (e) {
    throw new Error(`invalid native-host manifest: ${e.message}`);
  }
  manifest.path = LAUNCHER;
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(
    LAUNCHER,
    `@echo off\r\n"${process.execPath}" "${path.join(__dirname, "host.js")}"\r\n`,
  );
  console.log(`native host runtime -> ${RUNTIME_DIR}`);
}

for (const r of roots) {
  const key = `HKCU\\${r}\\NativeMessagingHosts\\${HOST}`;
  if (process.argv.includes("--remove")) {
    try {
      execFileSync("reg", ["delete", key, "/f"]);
      console.log(`${r}: deleted`);
    } catch {
      console.log(`${r}: not present`);
    }
    continue;
  }
  let current = "";
  try {
    const out = execFileSync("reg", ["query", key, "/ve"]).toString();
    current = ((out.match(/REG_SZ\s+(.*)/) || [])[1] || "").trim();
  } catch {}
  if (current === MANIFEST) {
    console.log(`${r}: OK -> ${current}`);
  } else {
    console.log(`${r}: was "${current}" -> re-adding`);
    execFileSync("reg", [
      "add",
      key,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      MANIFEST,
      "/f",
    ]);
    const verify = execFileSync("reg", ["query", key, "/ve"]).toString();
    console.log(
      `  now: ${((verify.match(/REG_SZ\s+(.*)/) || [])[1] || "").trim()}`,
    );
  }
}
console.log(
  "\nRemember: native-host/com.flex.pichatgptprobe.json allowed_origins must",
  "contain the unpacked extension ID shown on chrome://extensions.",
);
