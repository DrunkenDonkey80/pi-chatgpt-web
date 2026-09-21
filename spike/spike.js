// Disposable Milestone 0 feasibility spike. NOT product code.
// Stages:
//   node spike.js lock   — does a 2nd launchPersistentContext on the same profile fail natively?
//   node spike.js login  — open chatgpt.com, wait for MANUAL login, close, reopen, verify persistence
//   node spike.js send   — send a formatting test question, wait for completion, extract DOM + clipboard
const { chromium } = require("playwright");
const os = require("os");
const path = require("path");
const fs = require("fs");

// Keep the browser window alive if something unexpected throws — the user may be mid-login.
process.on("unhandledRejection", (e) => {
  console.log(
    `UNHANDLED (window kept open): ${e && e.message ? e.message.split("\n")[0] : e}`,
  );
});

const PROFILE_DIR = path.join(
  os.homedir(),
  "AppData",
  "Local",
  "pi-chatgpt-web",
  "chromium-profile",
);
const URL = "https://chatgpt.com";
const Q =
  "For a browser automation test, reply with exactly these four items and nothing else: 1) a fenced code block containing a tiny Python function, 2) a bullet list with one nested sub-item, 3) a two-column markdown table with one row, 4) one markdown link.";

function launch() {
  const exe = process.env.SPIKE_EXE || process.argv[3];
  const dir = PROFILE_DIR + (exe ? "-helium" : "");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  return chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
    args: ["--no-first-run", "--no-default-browser-check"],
    ...(exe ? { executablePath: exe } : {}),
  });
}

async function open(ctx) {
  let page = ctx.pages()[0] || (await ctx.newPage());
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(URL, { waitUntil: "commit", timeout: 45000 });
      break;
    } catch (e) {
      console.log(
        `goto attempt ${i + 1} failed: ${e.message.split("\n")[0]} (url now: ${page.url()})`,
      );
      await page.waitForTimeout(3000);
      if (/chatgpt\.com/.test(page.url())) break;
      const pages = ctx.pages();
      page = pages[pages.length - 1];
    }
  }
  await page.waitForTimeout(2000);
  if (!/chatgpt\.com/.test(page.url())) {
    console.log(
      `NAV_FAIL: could not reach chatgpt.com. Current url: ${page.url()}`,
    );
    process.exit(1);
  }
  return page;
}

async function loggedIn(page) {
  try {
    return (await page.locator("#prompt-textarea").count()) > 0;
  } catch {
    return false;
  }
}

async function waitLogin(page, ms) {
  const t0 = Date.now();
  let reported = false;
  try {
    while (Date.now() - t0 < ms) {
      if (page.isClosed()) return "closed";
      if (await loggedIn(page)) return true;
      if (!reported && Date.now() - t0 > 30000) {
        reported = true;
        const challenge = await page
          .content()
          .then((h) =>
            /verify you are human|just a moment|cf-challenge/i.test(h),
          )
          .catch(() => false);
        console.log(
          `still waiting for login... url=${page.url()} loginBtn=${await page
            .locator('button:has-text("Log in")')
            .count()
            .catch(() => -1)} challengeLike=${challenge}`,
        );
      }
      await page.waitForTimeout(2000);
    }
  } catch (e) {
    if (/closed/i.test(String(e.message))) return "closed";
    throw e;
  }
  return false;
}

async function stageLock() {
  const ctx1 = await launch();
  console.log("first context launched ok");
  try {
    const ctx2 = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
    });
    console.log(
      "LOCK_FAIL: second launch on same profile SUCCEEDED — native lock does NOT protect us",
    );
    await ctx2.close();
  } catch (e) {
    console.log(`LOCK_OK: second launch refused: ${e.message.split("\n")[0]}`);
  }
  await ctx1.close();
}

async function stageLogin() {
  let ctx = await launch();
  let page = await open(ctx);
  console.log(
    "STAGE1: browser window open — please log in manually (2FA etc.). Waiting up to 15 min...",
  );
  const ok = await waitLogin(page, 15 * 60 * 1000);
  if (ok === "closed") {
    console.log(
      "BROWSER_CLOSED: window closed before login finished. Rerun this stage when ready.",
    );
    process.exit(1);
  }
  if (!ok) {
    console.log(`STAGE1_FAIL: composer never appeared. url=${page.url()}`);
    await ctx.close();
    process.exit(1);
  }
  console.log("STAGE1_OK: logged in. Closing browser...");
  await ctx.close();
  ctx = await launch();
  page = await open(ctx);
  const still = await waitLogin(page, 60000);
  console.log(
    still
      ? "STAGE2_OK: login persisted across browser restart."
      : `STAGE2_FAIL: login did NOT persist. url=${page.url()}`,
  );
  await ctx.close();
  process.exit(still ? 0 : 1);
}

async function stableAssistantText(page) {
  let last = "",
    same = 0;
  for (let i = 0; i < 45; i++) {
    const n = await page
      .locator('[data-message-author-role="assistant"]')
      .count();
    const txt = n
      ? await page
          .locator('[data-message-author-role="assistant"]')
          .nth(n - 1)
          .innerText()
          .catch(() => "")
      : "";
    if (txt && txt === last) {
      if (++same >= 3) return txt;
    } else same = 0;
    last = txt;
    await page.waitForTimeout(2000);
  }
  return last;
}

async function stageSend() {
  const ctx = await launch();
  const page = await open(ctx);
  if (!(await waitLogin(page, 60000))) {
    console.log('SEND_FAIL: not logged in — run "node spike.js login" first.');
    await ctx.close();
    process.exit(1);
  }
  console.log("Logged in. Filling composer...");
  const composer = page.locator("#prompt-textarea").first();
  await composer.waitFor({ state: "visible", timeout: 30000 });
  await composer.fill(Q);
  const send = page.locator('button[data-testid="send-button"]').first();
  let sent = false;
  if (await send.count()) {
    try {
      await send.click({ timeout: 10000 });
      sent = true;
    } catch (e) {
      console.log(
        `send click failed (${e.message.split("\n")[0]}); trying Enter`,
      );
    }
  }
  if (!sent) {
    await composer.press("Enter");
    console.log("SENT_VIA_ENTER");
  }
  console.log("Sent. Waiting for generation start/finish...");
  await page
    .waitForSelector('button[data-testid="stop-button"]', { timeout: 30000 })
    .catch(() =>
      console.log("WARN: stop button never appeared (fast response?)"),
    );
  await page
    .waitForSelector('button[data-testid="stop-button"]', {
      state: "detached",
      timeout: 5 * 60 * 1000,
    })
    .catch(() => console.log("WARN: stop button still present after 5 min"));
  const dom = await stableAssistantText(page);
  console.log(`CONVERSATION_URL=${page.url()}`);
  console.log("=== DOM extraction ===");
  console.log(dom || "(EMPTY)");
  console.log("=== END DOM ===");
  const msgs = page.locator('[data-message-author-role="assistant"]');
  const n = await msgs.count();
  let clip = null;
  if (n) {
    await msgs
      .nth(n - 1)
      .hover()
      .catch(() => {});
    const copyBtn = page
      .locator('button[data-testid="copy-turn-action-button"]')
      .last();
    if (await copyBtn.count()) {
      await copyBtn
        .click({ timeout: 10000 })
        .catch((e) =>
          console.log(`copy click failed: ${e.message.split("\n")[0]}`),
        );
      await page.waitForTimeout(800);
      clip = await page
        .evaluate(() => navigator.clipboard.readText())
        .catch((e) => `CLIPBOARD_READ_FAIL: ${e.message}`);
    } else console.log("COPY_BTN_NOT_FOUND");
  }
  console.log("=== Clipboard extraction ===");
  console.log(clip === null ? "(no copy button clicked)" : clip);
  console.log("=== END clipboard ===");
  await ctx.close();
}

const stage = process.argv[2];
if (stage === "lock") stageLock();
else if (stage === "login") stageLogin();
else if (stage === "send") stageSend();
else {
  console.log("usage: node spike.js lock|login|send");
  process.exit(2);
}
