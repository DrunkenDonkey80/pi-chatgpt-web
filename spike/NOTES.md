# Spike status log (Milestone 0)

## Environment

- playwright installed locally: `C:\SOFT\git\pi-chatgpt-web\node_modules\playwright` (lockfile pinned)
- Managed Chromium: 153.0.8010.12 (playwright v1243) in `ms-playwright`
- Helium binary (Chromium fork, user's default browser): `C:\Users\Flex\AppData\Local\imput\Helium\Application\chrome.exe`
- Spike script: `spike/spike.js` (stages: `lock` / `login` / `send`, optional argv[3] = executable path)

## Results so far (2026-09-21)

### lock — PASS

Second `launchPersistentContext` on the same profile is refused natively by Chromium:
"Opening in existing browser session. This usually means that the profile is already in use by another instance of Chromium."
→ Plan's app-level ownership lock is unnecessary; catching this error is enough.

### login on managed Chromium — FAIL (Cloudflare loop)

chatgpt.com landing page loads fine (no challenge on initial HTML, login buttons present), but the
login flow hits a Turnstile human-check that re-emits endlessly and never passes. User attempted
to solve it manually; it loops. This is the P0 risk from the plan: automated-build fingerprint.

### login on Helium binary (dedicated profile `chromium-profile-helium`) — BLOCKED, retry later

Launch + navigation to chatgpt.com works (first goto needed `--no-first-run` + retry; ERR_ABORTED
on first attempt is Helium's onboarding hijacking navigation). Login attempt got as far as the
ChatGPT app, which then showed: `Route Error (400 Invalid content type: text/html; charset=UTF-8)`.
ChatGPT's client expected JSON but received HTML — suspects: Helium's built-in blocker/privacy
features mangling backend API responses, or Cloudflare serving HTML instead of JSON to this
fingerprint. User aborted to wait and retry.

### follow-up attempts (same day) — the loop is NOT Playwright

- Helium + Playwright, blocker disabled for chatgpt.com: reached auth.openai.com authorize page
  (email in flow via login_hint) but challenge-like content persisted → loop, user closed.
- **Plain manual Helium launch (zero Playwright), same dedicated profile, blocker disabled:
  SAME endless Turnstile loop.**
- User's daily Helium (own profile): logs in and out fine.

→ Root cause: **cold empty profile** — no cf_clearance/device cookies/history. Launch mechanism
(managed Chromium, Helium+Playwright, Helium manual) is irrelevant; the fresh profile identity
is what Turnstile loops on. IP is probably fine (daily profile works from same network;
cf_clearance is IP-bound).

## Next steps

### 2026-09-21 later — Chrome extension + native messaging route: PASS (new direction)

User rejected debug ports/profile tricks; pivoted to a regular MV3 extension in the daily Helium.

Proven, end to end, zero network ports:

- Helium loads unpacked MV3 extensions; content scripts run on chatgpt.com (green PI-PROBE banner).
- Native messaging fully functional: `connectNative`/`sendNativeMessage` true, host spawns.
- Extension → native host (Node via .bat) → spool file → readable by pi: `spike/spool/host-received.json`
  got the browser-originated ping ~100 ms after click. Registry roots read from Helium's chrome.dll:
  `SOFTWARE\Chromium\NativeMessagingHosts` and `SOFTWARE\Google\Chrome\NativeMessagingHosts`
  (both registered under HKCU; regcheck.js verifies/re-adds).
- Host works standalone too (length-prefixed stdio protocol, BOM-free manifest, extension ID pinned
  in allowed_origins: ljaknnmnjmcniidejfhdhlabbkppghhh).

→ Playwright transport is dead (cold-profile Turnstile). New architecture: content script on
chatgpt.com (composer/send/completion/extract) + background service worker + native messaging
host + spool dir ↔ pi extension. No Playwright, no profile lock, no captcha (rides the logged-in
daily browser). Probe artifacts: `spike/probe-extension/`, `spike/native-host/`.

1. ~~warm profile~~ superseded by extension route.
2. ~~Remaining unknowns for the extension route~~ → resolved by M1 below.
3. ~~Rewrite PLAN.md~~ → done (PLAN.md v2, extension architecture).

## Milestone 1 — in-page send/extract probe: PASS (2026-09-21)

Probe: banner button runs the whole flow in the current chatgpt.com tab; result relayed via one-shot
native messaging to `spike/spool/m1-result.json`.

### Runs

- **Run 1** (conv `6ab1797e…`): fill + send + completion + extract + relay — full pass.
- **Run 2** (same conv): **race found.** Send button was clicked before React committed the
  inserted text; ChatGPT sent its committed state (a stray `v`), the question landed in the
  composer after. The naive "a new assistant turn appeared" check passed on the answer to `v`
  (spool: `innerText: "v"`, gpt-5-6-thinking) — wrong association, silently.
- **Fix:** (a) readback — 300 ms settle after `insertText`, composer must contain the question;
  (b) send verification — last user turn must start with the question's first 40 chars AND the
  composer must have cleared before waiting on any answer, else abort with diagnostics; Enter
  retry at 8 s. **Run 3** (conv `6ab17aa7…`): clean full pass with verification in place.
- Conversation reuse: runs 1+2 sent into the same conversation; run 3 in a fresh one. Turn
  association via question prefix is exact regardless.

### Extraction fidelity (four-item formatting answer)

- `innerText` alone is **unusable**: fences + language lost, "Python"/"Run"/"Copy" UI chrome leaks
  in, list nesting flattened, table reduced to tab rows, link URL lost entirely (just `OpenAI`).
- The DOM retains everything: `<pre>` code container with language header text + inner
  `pre.cm-content > code`; nested `<ul>`-in-`<li>`; `<table><thead><th>`; `<a href="…">`.
  Wrapper: `[data-message-author-role=assistant]` with `data-message-id` and `data-start`/`data-end`
  source offsets.
→ **Decision:** extraction = small DOM→markdown walker in the content script (pre+header,
  lists, table, links, p/strong/em/headings). Copy-button/clipboard route rejected — needs
  `clipboardRead` + focus stealing, and the DOM already carries full fidelity.

### Completion detection

Stop-button (`button[data-testid=stop-button]`) gone + content stable 3×1.5 s — worked on all
runs; never confused with generation pauses. `network-idle` never used.

### Still open

- ~~Temporary-chat URL/indicator check~~ → **PASS** (user: new tab opened temp chat,
  M1 send ran there normally).

**M1 exit criteria met.** Next: M2 (pi extension v1) per PLAN.md.

## Milestone 2 — pi extension v1: PASS (2026-09-21)

Built: `native-host/` (long-lived host: port relay, 500 ms spool poll, 3 s heartbeat, 20 s keepalive,
`spool/host.log` message log), `extension/` (background: port + advisor tab + one-in-flight;
content: ask flow + DOM→markdown walker), `index.ts` (`/chatgpt` ask/status/recover), `state.ts`
(journal). Playwright uninstalled.

### Bugs found during bring-up (all fixed)

1. **Host relay spread order:** `{type:"command", ...cmd}` let the command file's own
   `type:"ask"` override → extension silently ignored every command. Fix: spread first.
2. **Untyped results:** extension result messages lacked `type:"result"` → host logged them but
   matched no handler → no result file. Round-1's "hang" was actually this: fast fail, dropped
   result, no logging. Fix: type added; results replay on port reconnect.
3. **Composer hydration:** fresh tabs at `readyState=interactive` expose only a fallback textarea
   (`wcDTda_fallbackTextarea`); `#prompt-textarea` mounts after React hydrates. Fix: poll up to 15 s.
4. **Testing gotchas:** git-bash MSYS converts `-p "/chatgpt …"` into `C:/Program Files/Git/chatgpt …`
   → command never dispatches, prompt goes to the model (use `MSYS_NO_PATHCONV=1`); headless
   command-only runs create **no session file** (`SessionManager._persist` defers until a real
   assistant message) → imported content is ephemeral in headless tests, persists in interactive
   sessions.

### Verified

- Full flow `/chatgpt <q>` headless: journal submitted→imported, answer `PI BRIDGE DONE` (14 chars ✓).
- Advisor reuse: 3 consecutive questions in conv `6ab18202…`; follow-up correctly recalled the
  previous phrase → same-thread proof beyond URL match.
- Recover: two ok:true results imported + files consumed; ok:false result skipped.
- Host kill → service-worker auto-reconnect + host respawn (pid chain 31640→30968→31376).
- End-to-end ask latency ~13 s for a short answer.

### Known edges (deferred)

- Extension reload mid-op loses the in-flight result (ack-then-process design); journal op stays
  `submitted` and shows as pending in `/chatgpt` status; no auto-resend (by design). Upgrade: ack
  after result.
- Orphaned advisor tabs after extension reloads: getAdvisorTab self-heals to a new tab; stale tabs
  remain until closed manually.

**M2 exit criteria met** (interactive acceptance by user pending). Next: M3 (`/tempgpt`).

## Milestone 3 — `/tempgct` real temporary chat: PASS (2026-09-21)

- background: `mode:"temp"` → fresh `?temporary-chat=true` tab per question (never touches the
  advisor tab), closed in a `finally` after the result is spooled — error or success both close it.
- content: temp guard — after the composer wait, refuses to send unless the page shows the
  "Temporary chat" indicator; no normal-chat fallback.
- index: `/tempgpt` shares `runAsk(mode)`; imported block labelled "(temporary chat)".
- Verified via spool: question → answer `TEMP OK` at the temporary-chat URL, ~46 s end to end
  (fresh tab + temp chat is slower than advisor reuse at ~13 s), tab auto-closed.

**M3 exit criteria met.** Next: M4 (side-chat mode) / M5 (docs) per PLAN.md.
