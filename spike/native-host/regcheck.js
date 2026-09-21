// Query/fix the native-messaging host registry entries without any shell escaping.
const { execFileSync } = require("child_process");
const MANIFEST =
  "C:\\SOFT\\git\\pi-chatgpt-web\\spike\\native-host\\com.flex.pichatgptprobe.json";
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
