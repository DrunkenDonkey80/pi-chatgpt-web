# Pi ↔ ChatGPT Web research

Research date: 2026-09-21

Follow-up implementation plan: `C:\SOFT\git\pi-chatgpt-web\PLAN.md`. The plan incorporates the later decisions: Playwright-managed Chromium, one owning Pi window at a time, automatic question-and-answer import for quick consultations, `/tempgpt`, and a separate side-chat UI. MCP and Projects are optional later additions, not baseline requirements. Where recommendations differ, follow the plan.

Source examined: `C:\Users\Flex\Downloads\codex-with-chatgpt` at commit `9663b88753e35c76796c5bce000293e0bd22cd9e`.

## Bottom line

Build `/chatgpt <question>` as an **advisor command first**, not as Pi's active model.

Pi can mechanically register a fake `chatgpt-web` model with a custom `streamSimple`, but ChatGPT Web is a stateful browser conversation while Pi providers are expected to accept Pi's supplied conversation state and participate in the agent loop. The mismatch makes a provider fragile around tools, retries, branches, compaction, model switching, and attachments.

The useful first version is:

1. `/chatgpt <question>` sends only that question to one ChatGPT Web chat bound to the current Pi session.
2. It reuses that chat on later `/chatgpt` calls, so ChatGPT keeps its own context.
3. The answer is shown in Pi and optionally inserted as a custom message so the active Pi model can use it.
4. Local code is not pasted. Reuse the source project's read-only MCP bridge so ChatGPT can inspect the workspace itself.
5. Do not implement automatic remote deletion initially. Group chats in one ChatGPT Project per workspace and reuse one chat per Pi session.

This gives the intended token separation without pretending the web UI is a normal stateless model API.

## What the source actually provides

`codex-with-chatgpt` is **not a ChatGPT Web client or provider**. It has two separate halves:

- A local/public read-only MCP bridge that lets ChatGPT read selected workspace data.
- A Codex skill containing browser-operating instructions. The skill assumes Codex has an in-app browser (`iab`) and tells it how to open ChatGPT, type prompts, read replies, and maintain conversation URLs.

There is no source module that sends a prompt to ChatGPT Web or extracts a response. Browser control is outside the TypeScript application and must be replaced for Pi.

The bridge exposes nine read-only tools:

- `workspace_info`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff`
- `test_status`
- `execution_summary`
- `execution_output`

Useful properties to retain:

- Workspace identity is derived from the canonical local path.
- Path traversal and symlink escapes are blocked.
- Sensitive files and `.c2cignore` matches are denied.
- Text reads are paginated; binaries are rejected.
- Search uses ripgrep with a Node fallback.
- The MCP endpoint uses OAuth, pairing, and a Cloudflare tunnel.
- The bridge is read-only; it does not execute commands or modify files.

References:

- `C:\Users\Flex\Downloads\codex-with-chatgpt\README.md`
- `C:\Users\Flex\Downloads\codex-with-chatgpt\docs\architecture.md`
- `C:\Users\Flex\Downloads\codex-with-chatgpt\docs\protocol.md`
- `C:\Users\Flex\Downloads\codex-with-chatgpt\src\mcp\server.ts`
- `C:\Users\Flex\Downloads\codex-with-chatgpt\src\workspace\manager.ts`
- `C:\Users\Flex\Downloads\codex-with-chatgpt\src\workspace\search.ts`

## Conversation behavior in the source

The source already settled on two modes:

### `long-chat`

One long-lived ChatGPT conversation per workspace. It is replaced only when the user asks, the chat becomes slow, the URL is lost, or the chat is unsuitable.

### `project`

One ChatGPT Project per workspace and one ChatGPT chat per coding-agent conversation. The same coding-agent conversation reuses its saved ChatGPT chat URL. A new coding-agent conversation creates a new chat inside the same Project.

That is also the best mapping for Pi:

```text
workspace path     -> one ChatGPT Project + one MCP connector
Pi session ID      -> one ChatGPT conversation URL
/chatgpt calls     -> reuse that conversation
```

The source persists URLs, task checkpoints, project URLs, and connector names in local session JSON. `c2c session clear` only drops the local chat pointer; it does **not** delete the remote ChatGPT conversation. In Project mode it deliberately keeps the Project binding.

References:

- `C:\Users\Flex\Downloads\codex-with-chatgpt\skill\SKILL.md:370-475`
- `C:\Users\Flex\Downloads\codex-with-chatgpt\src\session\state.ts:1-283`
- `C:\Users\Flex\Downloads\codex-with-chatgpt\src\cli\index.ts:871-999`

## Will every question create a new ChatGPT conversation?

Only if we design it badly.

The extension should create a ChatGPT chat on the first `/chatgpt` call in a Pi session, save its URL against Pi's session ID, and reuse it thereafter. Starting a new Pi session can create a new chat inside the workspace Project. This keeps unrelated Pi threads isolated without filling the top-level chat list with ungrouped conversations.

An inactivity timeout should initially mean only:

- release browser/page resources;
- keep the saved conversation URL;
- reopen it on the next question.

It should **not** mean delete the remote chat. Remote deletion is irreversible, browser-selector-dependent, and unnecessary for resource cleanup.

Possible later policy, only if clutter proves real:

- archive chats after a long idle period;
- delete only chats marked and created by this extension;
- require an explicit opt-in and keep a local audit record.

There is no inactivity-purge feature in the examined source.

## Temporary chats

Temporary Chat looks attractive for one-question calls because it avoids normal history and may be retained only temporarily. It is a poor default here because it intentionally gives up durable conversation context and does not fit the Project-per-workspace design.

Use a temporary/new disposable chat only for an explicit stateless command such as a future `/chatgpt --fresh <question>`. Do not use it for the default advisor thread.

Official source: [Temporary chat in ChatGPT](https://help.openai.com/en/articles/8914046-temporary-chat-in-chatgpt).

## Can it be a normal Pi model?

### Mechanically: yes

Pi extensions can call `pi.registerProvider()` and supply a custom `streamSimple` implementation for a nonstandard backend. The model would then appear in Pi's model list.

References:

- `C:\Users\Flex\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\custom-provider.md:3-89`
- `C:\Users\Flex\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\custom-provider.md:397-631`
- `C:\Users\Flex\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\extensions.md:1738-1860`

### Semantically: not reliably, unless heavily constrained

A Pi provider receives a `Context` containing the system prompt, messages, and tool definitions for the current request. A normal provider serializes that state for each call. ChatGPT Web already stores the history in its own conversation.

A fake provider therefore has two bad choices:

1. Send all Pi history every turn, duplicating content already present in the web chat and defeating the point.
2. Send only the newest user message, making the hidden web conversation authoritative and causing divergence when Pi retries, forks, compacts, switches models, or resumes from another branch.

Other gaps:

- ChatGPT Web does not return Pi's structured tool-call event protocol.
- Pi expects abort, error, stop-reason, usage, and streaming semantics.
- A browser refresh, login wall, CAPTCHA, UI redesign, or delayed generation can break a model turn.
- Pi may retry a request; blindly retrying could post the same prompt twice.
- Parallel turns would need strict per-chat locking.
- Web conversation state cannot be reconstructed exactly from Pi's session tree.

A provider experiment could be offered as **text-only, no-tools, one Pi session ↔ one web chat, latest-user-message only**. It should be labelled experimental, not presented as a normal coding model.

## Why the advisor command fits Pi better

Pi supports custom commands through `pi.registerCommand()`. A command can run its own async operation and use custom messages for a result that participates in later model context, or a TUI-only entry if it should remain display-only.

Relevant Pi behavior:

- `pi.sendMessage()` inserts an extension-defined message that participates in LLM context.
- `pi.appendEntry()` is suitable for durable TUI-only data that should not enter LLM context.
- `CustomMessage.content` can contain text and images.
- Session APIs expose a stable Pi session identity and lifecycle hooks for cleanup.

References:

- `C:\Users\Flex\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\extensions.md:1416-1595`
- `C:\Users\Flex\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\examples\extensions\qna.ts`
- `C:\Users\Flex\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\examples\extensions\send-user-message.ts`
- `C:\Users\Flex\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\core\messages.d.ts`

Recommended command result modes:

- Default: display the answer and add one labelled custom message, e.g. `ChatGPT advisor response`, to Pi's context.
- Optional `--display-only`: show it without adding it to the active model's context.
- Optional `--fresh`: use a new/disposable ChatGPT chat for this question.

Do not automatically send the entire Pi transcript. If context is needed, the user can include it in the command or ask ChatGPT to inspect the workspace through MCP.

## Files, images, and local data

### Source code and text files

Do not upload them through the browser by default. Reuse the read-only MCP bridge. ChatGPT can search and read only what it needs, which is safer and avoids repeating large content on every turn.

For files outside the bound workspace, require an explicit path and either:

- reject it; or
- copy/extract a bounded text representation into the prompt after user confirmation.

### Images

Pi represents images as structured image content, but the source bridge rejects binary files. Supporting images would require explicit browser upload or a new read-only image resource/tool. Browser upload is the shortest first implementation, with size/type limits and explicit user intent.

### PDFs and other documents

Prefer local extraction to bounded text, then send that text. Direct web upload adds UI fragility, retention concerns, and per-plan upload limits. Add it only when a real use case requires fidelity that extraction loses.

### Web pages

Do not build a scraper into the first version. ChatGPT Web may already browse, and Pi already has web tooling. If the user explicitly wants local preparation, fetch/extract a bounded page and send the result as text. Keep provenance URLs in the prompt.

Official file reference: [File Uploads FAQ](https://help.openai.com/en/articles/8555545-file-uploads-faq).

## Browser/control layer still required

The missing component is a reliable ChatGPT Web controller. The examined source expects an external in-app browser and supplies instructions, not code.

A Pi implementation needs one of:

1. A dedicated browser automation layer with a persistent authenticated profile.
2. A manual handoff flow where Pi prepares the prompt and the user pastes/returns the answer.
3. An official API instead of ChatGPT Web.

If browser automation is chosen, it must handle:

- login, CAPTCHA, and 2FA as user-only steps;
- persistent profile and cookie storage outside the repository;
- one queue/lock per ChatGPT conversation;
- deduplication keys so retries do not post twice;
- generation completion detection and cancellation;
- URL capture and local session mapping;
- UI change failures with a clear manual fallback;
- never reading or writing arbitrary browser storage tokens.

The source's connector setup is itself UI-driven and will also need automation or guided manual setup.

## Retention and clutter

OpenAI documents that normal/archived chats and related files follow account retention behavior, while Temporary Chats use a different short-lived flow. ChatGPT Projects organize chats, files, and instructions but are not an automatic purge mechanism.

Useful official references:

- [Chat and file retention in ChatGPT](https://help.openai.com/en/articles/8983778-chat-and-file-retention-in-chatgpt)
- [Temporary chat in ChatGPT](https://help.openai.com/en/articles/8914046-temporary-chat-in-chatgpt)
- [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)

Recommended policy:

- one Project per workspace;
- one chat per Pi session;
- reuse indefinitely by default;
- local idle cleanup only;
- explicit `/chatgpt forget` drops the local mapping but does not silently delete remote data;
- any future remote delete/archive command must only target chats created and tagged by this extension.

## Terms and operational risk

This is the largest nontechnical blocker.

OpenAI's consumer Terms of Use include a restriction against automatically or programmatically extracting data or output from the service. A browser-driven provider that reads ChatGPT responses is therefore materially riskier than the source project's human-facing/browser-assisted advisor workflow.

Official references: [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) and the [rest-of-world terms](https://openai.com/policies/row-terms-of-use/). Applicable terms vary by region.

Before implementing automated response extraction, confirm that the intended usage and the account's applicable terms permit it. An official API avoids this specific web-automation problem. This note is a product risk assessment, not legal advice.

The web UI is also not a stable API. Selectors, routes, feature availability, quotas, login checks, and model labels can change without compatibility guarantees.

## Minimal proposed architecture

```text
Pi extension
  /chatgpt <question>
        |
        v
  Session map
  Pi session ID -> ChatGPT project/chat URL + last activity
        |
        v
  Browser controller (missing from source)
        |
        +---- sends only the command question
        +---- reads one completed answer
        |
        v
  ChatGPT Web conversation
        |
        v
  C2C read-only MCP connector -> current local workspace
```

Extension responsibilities:

- register `/chatgpt`;
- identify the current Pi session and workspace;
- start/reuse the correct ChatGPT chat;
- serialize calls per chat;
- render the answer;
- optionally inject the answer into Pi context;
- persist only project/chat mapping and timestamps;
- expose setup/status/forget commands only when needed.

Reuse from the source:

- bridge, workspace security, MCP tools, OAuth/pairing, tunnel, connector naming;
- Project-per-workspace and chat-per-agent-session mapping;
- compact handoff concept when a chat is lost.

For the first implementation, treat `c2c` as an external JSON CLI/daemon. The package exposes only the `c2c` executable and does not publish a stable extension SDK or TypeScript declarations, so importing its internal modules would create unnecessary coupling.

Do not reuse initially:

- the full C2C PLAN/EXECUTED/REVIEW state machine;
- automatic remote purge;
- a fake model provider;
- generic scraping/upload pipelines.

## Suggested phases

### Phase 0 — policy and browser feasibility spike

Manually prove that the chosen browser controller can, with the user's authenticated profile:

- open a known ChatGPT conversation;
- send one uniquely tagged prompt;
- read exactly one completed response;
- survive a reload;
- distinguish login/CAPTCHA from generation failure.

Stop if terms or account policy do not permit the automation.

### Phase 1 — advisor MVP

- `/chatgpt <question>` only.
- One saved chat per Pi session.
- Text only.
- No auto-delete.
- No provider registration.
- No transcript forwarding.
- Optional MCP workspace access.

### Phase 2 — bounded context inputs

Only after the MVP is reliable:

- explicit file paths;
- images;
- display-only vs inject-into-context choice;
- `--fresh` disposable question mode.

### Phase 3 — experimental model facade

Only if users specifically need selecting `chatgpt-web` as the active Pi model. Constrain it to text-only/no-tools and document branch/retry limitations. Do not make it the default interface.

## Decision

The source is valuable primarily for its secure local workspace bridge and its conversation-management lessons. It does not solve the browser transport that a Pi extension needs.

The shortest credible product is an advisor command with persistent per-session web chats. A fake provider is possible as a UI registration trick, but it is the wrong first abstraction and cannot honestly behave like a normal Pi coding model without substantial state-reconciliation and tool-protocol work.
