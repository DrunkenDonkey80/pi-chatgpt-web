// Query/fix the native-messaging host registry entries (both Chromium and
// Chrome roots, as read from Helium's chrome.dll). Safe to re-run anytime.
const { execFileSync } = require("child_process");
const MANIFEST =
  "C:\\SOFT\\git\\pi-chatgpt-web\\native-host\\com.flex.pichatgptprobe.json";
const HOST = "com.flex.pichatgptprobe";
const roots = [
  "Software\\Chromium",
  "Software\\Google\\Chrome",
  "Software\\Helium",
  "Software\\imput\\Helium",
];

for (const r of roots) {
  const key = `HKCU\\${r}\\NativeMessagingHosts\\${HOST}`;
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
