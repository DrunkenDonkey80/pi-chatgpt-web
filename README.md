# pi-chatgpt-web

Consult ChatGPT's web UI from [pi](https://github.com/earendil-works/pi-coding-agent) using your
daily browser's logged-in session — no API key, no second browser, no debug port.

```
/chatgpt <question>              ask the persistent advisor thread, import Q + A
/chatgpt handoff <q>             same, but with recent session context prepended (you confirm first)
/chatgpt handoff <focus>: <q>    handoff that summarizes a specific topic, then answers
/chatgpt <url> last              import the last exchange from any ChatGPT conversation
/chatgpt <url> sum [msg]         ChatGPT summarizes that conversation as a resumable handoff
                                 (sum|summarize|summary|handoff|all all work), msg appended — import so the agent starts working
/chatgpt                         bridge status + pending operations
/chatgpt recover                 import captured-but-unimported answers
/chatgpt setup                    handoff budget, summarizer model/effort, send-cursor reset
/tempgpt <question>              ask via a real Temporary Chat (not saved to your history)
/tempgpt handoff ...             handoff variant of the above
/sidegpt start <q>               open (or resume) a side discussion tab — continue it in the browser
/sidegpt summary [focus]         import a ChatGPT-generated summary of the side discussion
/sidegpt last                    import just the last exchange from the side discussion
/sidegpt close | new             close the tab (resumable) | reset the binding entirely
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

## Install (once, ~2 minutes)

1. **Pack + pin** — `node install.js`. Packs `extension/` into a signed `extension.crx`
   (fixing Chromium 153's broken packer signature along the way), writes the native-host
   registry entries, and pins the host manifest to the stable extension ID. If your browser
   isn't Helium at the default path, edit `BROWSER` at the top of `install.js` first.
2. **Native host** — `node native-host\regcheck.js` (HKCU registration for the messaging host;
   safe to re-run anytime).
3. **Load the extension** — `chrome://extensions` → enable **Developer mode** → **Load
   unpacked** → select this repo's `extension/` folder. The manifest carries a committed key,
   so the extension ID is **stable** (`ajlnbjgehaidkajobnhkmchjaknjnalj`) no matter where the
   folder lives — it matches what `install.js` pinned, which is what makes the bridge work.
4. **pi extension** — add this repo to the `packages` array in `~/.pi/agent/settings.json`:

   ```json
   "packages": ["C:\\SOFT\\git\\pi-chatgpt-web"]
   ```

   (Or just run pi inside the repo — `package.json` wires `index.ts` up automatically.)
5. **Verify** — restart pi, run `/chatgpt` in any session: `bridge: UP`.

Why developer mode? Modern non-managed Chromium refuses every sideload route: self-hosted CRX
registry installs are ignored, drag-dropped CRXs fail with `CRX_REQUIRED_PROOF_MISSING`
(Google's counter-signature or nothing), and force-install policy only works on
enterprise-managed machines. Unpacked-with-pinned-key is the one install that survives with a
stable ID. `store-upload.zip` is kept ready if you ever want the unlisted-Chrome-Web-Store
route instead.

## Using it

```
/chatgpt how do I idiomatically retry on 429 in axios?
```

Follow-ups reuse one advisor conversation. `/chatgpt` (bare) reports bridge status and pending
operations; `/chatgpt recover` imports answers that were captured but never made it into a
session (e.g. pi quit mid-consultation).

### handoff — "where were we?"

`/chatgpt handoff what do you think about our ideas?` prepends the last ~6k chars of your
current session transcript (user + assistant text only) so ChatGPT knows the context — **you
get a confirmation prompt with the exact size before anything is sent**. ChatGPT is asked to
summarize first, then answer. Only your short question is imported back into the session; the
transcript never lands in pi's context a second time.

With a focus: `/chatgpt handoff the message format: what do you think?` — everything before the
first `:` names the topic to summarize; everything after is your question. The summary itself is
made locally: a throwaway `pi -p` run (model + effort configurable in `/chatgpt setup`, default
is the current session model) sees only the budgeted transcript slice, and its bullet summary —
not the raw transcript — goes to ChatGPT. If the local summarizer fails, the handoff falls back
to the plain transcript variant. `/chatgpt handoff llm: what?` uses the same mechanism but asks
for a summary with no topic.

The advisor thread remembers what it has already seen: after each handoff a send-cursor is
saved, so the next handoff sends only the new exchanges (a handoff with nothing new sends your
question alone). `/chatgpt setup` can reset the cursor; temp/side handoffs never move it.

Advisor threads are **per project**: each workspace folder gets its own ChatGPT conversation
(dedicated tab), so alternating `/chatgpt` between ten open projects stays consistent per
project. The first message of a new thread is labeled `[project: <folder>]` so ChatGPT's
auto-title names it — rename it by hand if you like. The conversation URL is remembered, so
closing the tab or restarting Helium resumes the same thread; `/chatgpt` status lists the
threads it knows. Side discussions (`/sidegpt`) are per-project the same way: each folder
gets its own side tab and conversation.

### NEED: — ChatGPT can read your files

Every outgoing question carries a one-line footer inviting ChatGPT to reply with

```
NEED: package.json, extension/manifest.json
```

When it does, pi reads those paths **inside the current workspace only** (≤8 paths, 64 KB
budget, `node_modules`/`.git` skipped), sends them back on the same conversation, and only the
real answer gets imported. Up to 2 rounds per consultation, advisor thread only (temporary
chats can't be continued). `NEED: .` asks for the file tree. If it requests something outside
the workspace, it gets refused in-band.

## ChatGPT as an agent

Other extensions — and any agent running in this pi process — can use ChatGPT without
importing anything into your session transcript:

- **Tool**: `chatgpt_consult` is registered for the LLM. Any session, subagent, or ce-workflow
  agent can call it with `{question, mode?, files?}`. Advisor mode (default) continues this
  project's conversation, `NEED:` file requests are answered automatically (≤2 rounds), and the
  final answer is returned to the calling agent only. `files` (optional) attaches up to 3
  workspace files (2MB total) — staged into the spool, pulled by the extension, and attached
  for real in the composer (images, PDFs, text).
- **Direct call**: extension code can import this module and call
  `askChatGPT(pi, ctx, question, "advisor" | "temp", files?)` → `{answer, url}` — same flow, no
  transcript import.

## Disable / remove

- Disable the extension in the browser (the host exits with its port).
- `node install.js --remove` drops the registry entries;
  `node native-host\regcheck.js --remove` drops the native-host entries.
- Remove the repo from pi's `packages`. Registry entries are inert without the extension.

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

Nothing leaves your machine except what you explicitly send: the text after `/chatgpt`
(plus the transcript slice you approve for `handoff`, and any files ChatGPT asked for via
`NEED:` — workspace-bounded). Pi's context is never sent wholesale.

Driving the web UI is automated use of ChatGPT; that's your account risk to own.

## Development

- Self-checks: `node --experimental-strip-types test/handoff.test.mjs`
- After editing `extension/`, re-run `node install.js` and reload the unpacked extension.
- Architecture history and the why of every decision: `PLAN.md`, `RESEARCH.md`,
  `spike/NOTES.md`.
