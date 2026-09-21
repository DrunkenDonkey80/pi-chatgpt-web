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

## Milestone 4 — `/sidegpt` side discussions: PASS (2026-09-21)

Decision (per PLAN §7/§12): **browser tab**, not a pi panel — the user continues the discussion by
hand in the dedicated tab; pi only opens it and imports what the user approves.

- `/sidegpt start <q>`: opens the side tab (or resumes the stored conversation), sends the first
  question, waits for completion, persists the conversation URL to `chrome.storage.local`, then
  brings the tab to the front. Imports nothing.
- `/sidegpt summary [focus]`: sends the summary instruction as a real web message, imports the
  summary (label "side discussion (summary)").
- `/sidegpt last`: extract-only — no send; waits out a running generation (stop-button poll),
  grabs last user turn + last assistant answer, imports as "last exchange".
- `/sidegpt close`: closes the tab, keeps the URL binding (close-and-resume).
- `/sidegpt new`: closes and clears the binding (fresh discussion next start).
- Side ops share the one-in-flight guard; side results carry `mode` so recovery labels correctly.

Verified via spool, all in conversation `6ab186fe…`: start → names brainstorm → summary (bullet
points, real web message) → last (Q = summary prompt, A = summary) → close → resume (start
reopened the same conversation and ChatGPT recalled the earlier discussion).

Deferred: preview/edit-before-import (import is immediate and fully visible in the imported
block; add a confirm step only if real usage wants one).

**M4 exit criteria met.** Next: M5 (hardening + README) per PLAN.md.

## Milestone 5 — hardening: PASS (2026-09-21)

Failure-matrix pass (PLAN §11) + fixes:

1. **recover() was mode-blind and non-idempotent.** Fixed: imports only
   `advisor|temp|side-summary|side-last`; control results (side-start/close/new) and failed results
   are consumed, never imported; already-imported ids (crash window) skipped; late failed results
   close needs-attention ops; existing journal ops are updated instead of duplicated (`findOp` in
   state.ts).
2. **temp/advisor sendResult lacked `mode`** — a temp result recovered after a pi timeout would
   import labelled as advisor (observed live on the M3 temp result). Both branches now tag `mode`.
3. **Draft guard (content.js):** if the composer holds user draft text, abort — never type into a
   conversation the user is composing in.
4. **regcheck.js --remove:** deletes the HKCU entries (full disable; files stay).
5. **Bridge-down hint** now mentions the moved-extension/new-ID case (re-run regcheck).

Verified headless: `/chatgpt recover` on the M4 leftovers → 2 imported (side-summary, side-last,
correct labels), 4 skipped/consumed (control + stale M2 failure); second run = nothing to recover
(files consumed = idempotence). `node --check` clean on all bridge JS.

Local-data documentation added to README (retention table for every spool file, secrets warning,
how to purge). Deferred/manual: live disable/reload toggle test (user, one toggle), draft-guard
   live behavior (code-reviewed), host.log rotation (none — delete anytime, documented).

**M5 exit criteria met. M0–M5 complete.**

## Post-M5 — real install, no developer mode (2026-09-21)

Unpacked extensions force developer mode forever; the web store is out of scope (private).
Used the documented Windows sideload instead: `install.js` packs `extension/` into a
self-signed CRX3 (headless `chrome --pack-extension` — proven to exit 0, no dialog) with a
committed key, so the extension ID is **stable** (no longer folder-path-derived), registers
it as an external extension under `HKCU\<root>\Extensions\<id>` (Chromium / Google\Chrome /
Helium roots, `path` + `version` values), and re-pins the native host manifest to the ID.

- Key: `extension.pem` (committed; private repo). Build artifact `extension.crx` gitignored.
- `node install.js --remove` unregisters; re-run `node install.js` after any manifest change.
- Packed extension ID: `jlnbjgehaidkajobnhkmchjknjnalj` (v0.1.0). Old unpacked copy must be
  removed once (different ID, no longer in `allowed_origins`).

Pending live proof: Helium relaunch → extension present without developer mode → `/chatgpt`
works.
