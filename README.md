# pi-chatgpt-web

Consult ChatGPT's web UI from [pi](https://github.com/earendil-works/pi-coding-agent) using your
daily browser's logged-in session — no API key, no second browser, no debug port.

```
/chatgpt <question>   ask the persistent advisor thread, import question + answer
/chatgpt              bridge status + pending operations
/chatgpt recover      import captured-but-unimported answers
/tempgpt <question>   ask via a real Temporary Chat (not saved to your history)
/tempgpt              bridge status + pending operations
/sidegpt start <q>    open (or resume) a side discussion tab — continue it in the browser
/sidegpt summary      import a ChatGPT-generated summary of the side discussion
/sidegpt last         import just the last exchange from the side discussion
/sidegpt close|new    close the tab (resumable) | reset the binding entirely
```

The imported consultation lands in the pi session as a custom message — visible to the model on
its next turn, without spending an extra model call.

## How it works

```
pi (/chatgpt command)
  ↕ spool/ JSON files (command-<id>.json, result-<id>.json, heartbeat.json)
native host (node, spawned by the browser)
  ↕ Chrome native messaging port
MV3 extension (background service worker → dedicated chatgpt.com tab → content script)
  → fills the composer, sends, verifies the turn, waits for completion,
    extracts the answer DOM→markdown
```

The extension only ever touches `chatgpt.com`. Nothing listens on the network. The host talks to
exactly one pinned extension ID.

## Setup (once)

1. **Extension + host pin** — `node install.js`. Packs `extension/` into a signed
   `extension.crx`, registers it as an external extension (no developer mode, no web store),
   and pins the native host manifest to the resulting stable extension ID. Then fully quit
   Helium (tray icon too) and relaunch — it appears in `chrome://extensions` as a normal
   install. Remove any old unpacked copy.
2. **Host registry** — `node native-host\regcheck.js` (writes HKCU entries pointing at the host
   manifest; safe to re-run).
3. **pi extension** — `pi install <path-to-this-repo>` or add the path to
   `~/.pi/agent/settings.json`:

   ```json
   "extensions": ["C:\\path\\to\\pi-chatgpt-web"]
   ```

The signing key (`extension.pem`) is committed, so the extension ID is **stable forever** —
moving the folder or repacking keeps it. After editing `extension/`, re-run `node install.js`
and restart the browser. Fallback: developer mode + *Load unpacked* still works, but the ID
then depends on the folder's absolute path.

## Use

Ask from any pi session:

```
/chatgpt how do I idiomatically retry on 429 in axios?
```

Follow-ups reuse one advisor conversation. `/chatgpt` (bare) reports bridge status and pending
operations; `/chatgpt recover` imports answers that were captured but never made it into a
session (e.g. pi quit mid-consultation).

## Disable / remove

- Disable the extension in the browser (the host exits with its port).
- `node install.js --remove` unregisters the packed extension;
  `node native-host\regcheck.js --remove` drops the native-host entries.
- Remove the pi extension entry.
- Registry entries become inert; delete them if you want:
  `HKCU\Software\Chromium\NativeMessagingHosts\com.flex.pichatgptprobe` (and the
  `Google\Chrome` / Helium variants).

## Local data & retention

Everything private lives in `spool/` (gitignored):

| file | contents | lifetime |
| --- | --- | --- |
| `command-<id>.json` | outgoing question | consumed on ack |
| `result-<id>.json` | question + answer + conversation URL | until imported (`/chatgpt recover`) |
| `heartbeat.json` | host pid + timestamp | rewritten every few seconds |
| `host.log` | full bridge messages (includes Q&A) | grows forever — delete anytime |
| `journal.jsonl` | operation history (questions, URLs, statuses) | append-only |

Delete the contents of `spool/` any time you want a clean slate; the bridge recreates what it
needs (already-imported consultations stay imported). The extension itself stores only the side
discussion conversation URL in `chrome.storage.local`. Since questions and answers sit on disk in
plaintext, **don't put secrets in `/chatgpt` questions**.

## Privacy

`spool/` (gitignored) contains your questions and answers in plain text, plus a host log of
bridge messages. Nothing leaves your machine except the questions you explicitly send to
chatgpt.com through your normal logged-in browser session. Pi's context is never sent — only
the text you type after `/chatgpt`.

Driving the web UI is automated use of ChatGPT; that's your account risk to own.

## Status

M0–M5 done (probes, send/extract, full bridge + import, temporary chat, side discussions,
hardening) + real install without developer mode (`install.js`). See `PLAN.md` and
`spike/NOTES.md`.
