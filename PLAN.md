# Pi ChatGPT Web — implementation game plan (v2, extension architecture)

Status: planning + feasibility probes. Milestone 0 probes are **done and passing**; no product code yet.

Supersedes the earlier Playwright-based plan. v1 is preserved in git history of this document; `RESEARCH.md` remains the source investigation. Spike evidence and decision log: `spike/NOTES.md`.

## 1. Target experience

A private, easy-to-disable Pi integration that removes manual copying between Pi and ChatGPT Web:

- `/chatgpt <question>` consults a persistent advisor conversation and puts **the question and the completed answer** into the current Pi session — usable by the active Pi model on its next turn, without spending an extra model call.
- `/tempgpt <question>` does the same through ChatGPT's actual Temporary Chat, without touching the persistent advisor conversation.
- `/chatgpt` (bare, later milestone) opens an extended side discussion; only an approved summary or last exchange is imported.
- ChatGPT receives only explicitly sent text, never Pi's whole context.
- Runs inside the user's **default daily browser** — no second browser, no login choreography, no captcha exposure.

### Decisions (settled)

| Decision | Direction |
| --- | --- |
| Transport | MV3 Chrome extension in the default Chromium-compatible browser + native messaging host + spool files. **No Playwright, no CDP, no debug port, no second browser** |
| Scope of extension power | `chatgpt.com` only (host permissions + content script matches) |
| Login | None needed — rides the user's logged-in daily browser |
| Concurrency | One consultation in flight at a time (enforced browser-side) |
| Quick consultations | Import both the question and the final answer automatically |
| Side discussions | Separate feature; import only approved summary/last exchange |
| Temporary questions | Real Temporary Chat per question |
| Normal Pi model | Untouched; no fake provider |
| MCP / Projects / uploads | Out of scope until asked for |
| Distribution | Private local code; easy off (disable extension + pi extension) |

### Why the pivot (decision history)

- Playwright-managed Chromium and fresh Helium profiles both hit an endless Cloudflare Turnstile loop on login. Even a **plain manual launch** on a cold profile loops — the blocker is the empty profile identity, not automation. Warming profiles was rejected as impractical.
- Attaching CDP to the daily browser was rejected (open debug port; Chromium 136+ also blocks it on default profiles).
- The user proposed and we **proved end-to-end**: content scripts run on chatgpt.com in Helium, native messaging works (registry roots read from Helium's `chrome.dll`: `SOFTWARE\Chromium\NativeMessagingHosts`, `SOFTWARE\Google\Chrome\NativeMessagingHosts`), and a browser-spawned Node host exchanges messages and writes spool files Pi can read. Zero network sockets.

## 2. Proven vs remaining unknowns

| Claim | Status |
| --- | --- |
| Helium loads unpacked MV3 extensions | ✅ proven (probe banner on chatgpt.com) |
| Content scripts run on chatgpt.com | ✅ proven |
| Native messaging API + host spawning | ✅ proven (ping → spool file, ~100 ms) |
| Host stdio protocol, standalone | ✅ proven (length-prefixed JSON, echo + spool) |
| Registry registration (HKCU, both roots) | ✅ proven (`spike/native-host/regcheck.js` verifies/re-adds) |
| Composer fill + send click from content script | ⬜ Milestone 1 |
| Completion detection inside the page | ⬜ Milestone 1 |
| DOM→Markdown extraction fidelity | ⬜ Milestone 1 |
| Dedicated background tab reuse | ⬜ Milestone 1 |
| Temporary Chat URL/tab behavior | ⬜ Milestone 1 |
| Long-lived native port + service-worker keepalive | ⬜ Milestone 2 |
| Pi-side import mechanics | verified against pi 0.85.1 docs/runtime (see §8), implementation pending |

## 3. Architecture

```text
Pi extension (/chatgpt command, import, recovery)
   ↕ spool directory (small JSON files, atomic writes)
      command-<id>.json · result-<id>.json · heartbeat.json · state.json
Native host  (node host.js via host.bat — spawned BY the browser when the
extension opens its native port; long-lived while the port is open)
   ↕ native messaging port (chrome.runtime.connectNative, extension ID pinned)
Extension background service worker
   ↕ chrome.tabs / chrome.scripting
Content script in a dedicated chatgpt.com tab
   → fills composer, clicks send, watches for completion, extracts answer
```

### Bridge mechanics (the part MV3 makes non-obvious)

- The **browser spawns the host** when the service worker calls `connectNative`. Pi cannot reach the extension directly; the spool directory is the only pi↔host channel.
- **Keepalive:** MV3 service workers die after ~30 s idle. The host sends a ping over the port every ~20 s (port activity keeps the worker alive — standard MV3 native-messaging pattern). If it still dies, the next spool poll or alarm reconnects; the port is re-established lazily.
- **Heartbeat:** the host rewrites `spool/heartbeat.json` every few seconds. Pi treats a stale heartbeat (>15 s) as "bridge down" and reports it with fix hints (browser closed? extension disabled? reload needed?).
- **Flow for a consultation:** pi writes `command-<id>.json` → host relays over the port → service worker ensures the advisor tab exists, injects/asks the content script → content script performs the exchange, returns `{conversationUrl, question, answer, meta}` → service worker → port → host writes `result-<id>.json` → pi imports. Host polls the spool at a short interval (250–500 ms) while connected.
- **Ownership is enforced by construction:** the extension can only ever touch `chatgpt.com`; the host only ever talks to the pinned extension ID; nothing listens on the network.

## 4. Source layout

Promote the probe artifacts into product dirs at Milestone 2 start (keep `spike/` as evidence).

| Path | Responsibility |
| --- | --- |
| `extension/manifest.json` | MV3: `nativeMessaging`, `tabs`, content scripts on `chatgpt.com/*` |
| `extension/background.js` | Native port + keepalive, spool relay via host, tab lifecycle, per-conversation queues |
| `extension/content.js` | ChatGPT page adapter: composer fill, send, completion detection, extraction, temporary chat |
| `native-host/host.js`, `host.bat`, `regcheck.js` | stdio host, spool polling, heartbeat (evolved from the proven probe) |
| `index.ts` | Pi extension: commands, coordinator, spool client, import, recovery |
| `state.ts` | Operation records, thread bindings, atomic writes |
| `README.md` | Setup (load unpacked, regcheck once, ID pinning), privacy, disabling, recovery |

Dependencies: `playwright` is **dropped** (uninstall when M2 starts; probe evidence stays in `spike/NOTES.md`). Pi packages as peers per Pi's package docs. Node stdlib only for the host.

## 5. Setup (one-time, documented in README)

1. Load `extension/` as an unpacked extension in the default browser (`chrome://extensions` → Developer mode).
2. Read the assigned extension ID and put it in the host manifest's `allowed_origins`.
3. Run `node native-host/regcheck.js` (writes + verifies HKCU registry entries pointing at the host manifest, both roots).
4. Keep the default browser running while consulting. That's the whole story — no login step, no browser install.

Note: unpacked extension IDs derive from the **absolute folder path**. Moving `extension/` changes the ID and breaks the registry pin — re-run regcheck after any move (regcheck prints the expected ID derivation hint; README documents it).

## 6. Context boundaries

Unchanged from v1, condensed:

| History | Normal Pi model sees it? |
| --- | --- |
| Pi conversation + imported consultations | Yes (subject to Pi compaction) |
| Local spool/state (raw answers, pending ops) | No, never automatically |
| ChatGPT web conversation | Only what is explicitly imported |

Rules: slash-command argument is the entire web prompt (no auto-expanding file refs or Pi context); quick and side threads are separate web conversations; thread separation ≠ account-level memory isolation; `/tempgpt` is temporary on the web, permanent once imported into Pi; "outside model context" is not encryption; after Pi compaction, imported advice may be summarized — keep captured sources in spool state rather than re-injecting.

## 7. ChatGPT tab & conversation handling

- The background worker owns **one dedicated advisor tab** (opened in background, reused across consultations). It never drives whatever tab the user is actively reading. If the user is mid-conversation in that tab, the operation waits or reports a conflict — it must not type into a chat the user is using.
- Advisor thread = one conversation URL, reused for follow-ups. `/chatgpt-control` → "new advisor thread" detaches the binding (no remote deletion).
- `/tempgpt` opens a fresh Temporary Chat tab per question (`chatgpt.com/?temporary-chat=true` unless the probe shows otherwise), verifies the temporary indicator **before sending**, closes the tab only after the result is spooled.
- Side discussion (later): a second dedicated tab bound like the advisor tab; Pi-side panel optional — decide panel vs "use the browser tab" after real usage.

## 8. Sending, completion, extraction (content-script contract)

1. Verify: dedicated tab, correct conversation, composer idle, no other operation in flight, temporary indicator when required.
2. Fill composer (ProseMirror `#prompt-textarea`), one send action. Record pre-send state (last turn markers) to associate the new user turn with this operation.
3. Completion = new assistant turn for this operation + stop-button gone + content stable across short polls. Background traffic must not fake completion; network-idle is not a contract.
4. Extraction: last `[data-message-author-role="assistant"]` message. **Milestone 1 compares DOM→Markdown vs the copy-button route** (extension has `clipboardRead` available if needed; clipboard use requires explicit user approval per plan) on a response containing a fenced code block, nested list, table, and link. Pick the smaller lossy path; document the loss.
5. Result (question + answer + conversation URL + turn markers) returns through the port to spool **before** any Pi import. Selectors live only in the content script.
6. Cancellation: before send = abort locally; after send = attempt Stop once, keep partial + ambiguity, never mark partial as complete.

## 9. Pi-side persistence, recovery, import

- Operation states: `prepared → submitted → captured → imported`, plus `needs-attention` on ambiguity. Simple append-only journal is fine; crash boundaries (submission may have happened; captured-before-import) are the invariants that must survive. Never auto-resend; never auto-import into a session that changed.
- Pi integration APIs (verified against installed pi 0.85.1):
  - `pi.registerCommand()` for commands; `pi.appendCustomEntry()` for non-model markers.
  - Import via `pi.sendMessage(..., { triggerTurn: false })` at an idle, revalidated destination — **not** `sendUserMessage()` (triggers a model turn) and not `deliverAs: "nextTurn"` (queues until the next prompt; the idle custom message is appended immediately).
  - Put the actual question/answer in message `content` (model-visible), not only `details`; custom message `display:false` does **not** hide content from the model.
  - Session-file caveat: `SessionManager._persist()` (0.85.1) can defer creating a session file until the first normal assistant message — a `/chatgpt`-only session may not be on disk. Hence: captured answers always land in the local spool/state first, and recovery offers explicit import from a later session. Recheck on pi upgrades.
  - `--no-session`: respect ephemeral mode — no durable consultation journal, warn that recovery is unavailable.
- Session/branch mapping: advisor binding belongs to a Pi session + recorded branch anchor. On fork/rewind, don't treat the web thread as rewound: if the binding's anchor isn't in the current ancestry, start a fresh advisor thread lazily (conservative reset — no ancestry-walking engine).

## 10. Safety, privacy, easy-off

- Account risk: driving the web UI via an extension is still automated use of ChatGPT — the v1 terms-of-use caution stands. Private use only; if challenges appear, stop and fall back to manual copy.
- Extension blast radius: `chatgpt.com` host permissions only; answers are untrusted external text — escape terminal control sequences, never execute/open paths because ChatGPT said so.
- No secrets in spool/logs by default; spool contains private conversation text — document location and OS-level protection honestly.
- Easy off: disable the extension in the default browser (port dies, host exits) and/or remove the Pi extension. No daemon survives; registry entries are inert without the extension (documented removal: `regcheck.js --remove`).
- Loading the pi extension must not start anything: no browser action, no native messaging, no spool writes until a command runs.
- Manual fallback is documented (copy/paste via the visible tab), not built as a second product.

## 11. Failure reference (condensed)

| Situation | Behavior |
| --- | --- |
| Heartbeat stale / port down | "Bridge down" + fix hints (browser closed, extension disabled, reload); commands refused, never queued blindly |
| Extension updated/moved (new ID) | Regcheck mismatch message with the exact re-pin steps |
| Wrong tab state / user typing in advisor tab | Wait or report conflict; never type into an active user conversation |
| Temporary Chat indicator absent | Fail before sending; no normal-chat fallback |
| Selector drift inside chatgpt.com | Operation fails with captured pre-state; spool keeps partials; never auto-retry sends |
| Pi busy at capture | Hold result; import when idle after revalidating destination |
| Pi session changed mid-flight | Hold for explicit recovery; no cross-session auto-import |
| Default browser closed mid-consultation | Port dies; operation marked needs-attention; answer may exist on the web — recovery offers to fetch it after reconnect |
| Duplicate recovery attempts | Idempotent by operation id; no double import on the same branch |

## 12. Milestones

### M0 — probes (DONE)

Extension load, content script, native messaging, host, registry: all proven. Evidence: `spike/NOTES.md`, `spike/probe-extension/`, `spike/native-host/`.

### M1 — in-page exchange probe

Extend the probe extension: dedicated background tab → fill → send → completion detect → extract. Test both extraction paths on a formatting-heavy answer; check temporary-chat URL; prove reuse of the same conversation for a second question. **Exit:** question+answer extracted faithfully (or losses documented), completion never confused with pauses, one conversation reused across two sends.

### M2 — pi extension v1 (`/chatgpt`)

Promote dirs, drop playwright dep, implement port+keepalive+heartbeat+spool protocol, commands, coordinator, import, recovery, control menu. **Exit:** two questions reuse one advisor chat; unused session creates nothing; question+answer imported with no model call triggered; bridge-down and reload recover without duplicate sends; import survives Pi restart via spool.

### M3 — `/tempgpt`

Temporary tab per question, verified indicator, closed after spool, isolated from advisor binding.

### M4 — side discussion

Decide browser-tab vs Pi panel from real usage; exit choices (import summary via a real web message, or last exchange, or close-and-resume); preview/edit before summary import; deduped imports.

### M5 — hardening + README

Failure matrix pass, no-secrets-in-logs check, disable/reload test, retention/local-data documentation, pinned known-good default-browser behavior notes.

## 13. Definition of done

1. Ask `/chatgpt question` from any Pi session; question + answer appear and the model uses them next turn.
2. Follow-ups reuse one advisor conversation; nothing is created for unused sessions.
3. `/tempgpt` gets isolated temporary answers without touching the advisor thread.
4. Side discussions import only approved summary/last exchange; close-without-import resumes later.
5. Recovery from bridge-down, browser close, Pi restart never duplicates a send or mis-imports.
6. Disabling everything leaves zero running processes and an inert registry entry.

## 14. References

- Spike evidence + decision log: `C:\SOFT\git\pi-chatgpt-web\spike\NOTES.md`
- Probe artifacts: `spike/probe-extension/` (manifest/background/content), `spike/native-host/` (host.js, host.bat, regcheck.js, host manifest)
- Research record: `C:\SOFT\git\pi-chatgpt-web\RESEARCH.md`
- Pi docs: `C:\Users\Flex\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\` (extensions.md, packages.md, session-format.md); runtime cross-checks in `dist/core/session-manager.js`, `dist/core/agent-session.js` (pi 0.85.1)
- Chrome docs: MV3 service worker lifecycle & native messaging (keepalive pattern), unpacked extension ID derivation

**Next implementation action:** Milestone 1 — the in-page send/extract probe on a real conversation.
