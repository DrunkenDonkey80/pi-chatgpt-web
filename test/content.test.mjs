// Content-script self-check: composer discovery, sending, and draft ownership.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../extension/content.js", import.meta.url),
  "utf8",
);
const question = "composer regression test";
const editor = (options = {}) => ({
  id: "",
  tagName: "DIV",
  className: "ProseMirror",
  textContent: "",
  isConnected: true,
  visible: true,
  composerMarker: true,
  nested: false,
  getClientRects() { return this.visible ? [{}] : []; },
  closest() { return this.nested ? {} : null; },
  getAttribute() { return "true"; },
  ...options,
});

async function consult(editors, {
  failInsert = false, mode = "advisor", layout = "legacy", temporaryIndicator = false,
  apiUnavailable = false, wrongApiQuestion = false,
} = {}) {
  let listener;
  let focused;
  let clock = 0;
  let sent = false;
  const edits = [];
  const users = [];
  const assistants = [];
  const reply = {
    innerText: "test answer",
    children: [{
      tagName: "P",
      childNodes: [{ nodeType: 3, textContent: "test answer" }],
    }],
    querySelectorAll: () => [],
    querySelector: (selector) => selector === ".markdown" ? null : {},
  };
  if (mode === "side-last") {
    users.push({ innerText: question });
    assistants.push(reply);
  }
  for (const el of editors) el.focus = () => { focused = el; };
  const sendButton = {
    disabled: false,
    click() {
      sent = true;
      users.push({ innerText: focused.textContent });
      focused.textContent = "";
      assistants.push(reply);
    },
  };
  const document = {
    readyState: "complete",
    body: { appendChild() {}, innerText: temporaryIndicator ? "Temporary chat" : "" },
    createElement: () => ({ style: {}, remove() {} }),
    querySelector(selector) {
      if (selector.startsWith("#prompt-textarea"))
        return editors.find((el) => el.id === "prompt-textarea") || null;
      if (selector === 'button[data-testid="send-button"]') return sendButton;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-composer-markdown][contenteditable="true"]')
        return editors.filter((el) => el.composerMarker);
      if (selector === 'textarea, [contenteditable="true"]') return editors;
      if (selector === '[data-message-author-role="user"]') return layout === "legacy" ? users : [];
      if (selector === '[data-message-author-role="assistant"]') return layout === "legacy" ? assistants : [];
      if (selector === '[data-message-author-role="user"], [data-user-message-bubble]') return users;
      if (selector === '[data-message-author-role="assistant"], [data-dil-message-id]') {
        if (layout === "unmarked") return [];
        return layout === "mixed" ? assistants.flatMap((el) => [el, {
          parentElement: { closest: () => el },
        }]) : assistants;
      }
      throw new Error(`unexpected selector: ${selector}`);
    },
    execCommand(command, _ui, value) {
      edits.push(command);
      if (command === "delete") focused.textContent = "";
      if (command === "insertText") focused.textContent = value;
      return !(command === "insertText" && failInsert);
    },
  };
  vm.runInNewContext(source, {
    document,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
    location: {
      href: "https://chatgpt.com/c/00000000-0000-0000-0000-000000000000",
      pathname: "/c/00000000-0000-0000-0000-000000000000",
    },
    Date: { now: () => clock },
    setTimeout(fn, ms) { clock += ms; queueMicrotask(fn); },
    fetch: async (url) => ({
      ok: true,
      json: async () => url === "/api/auth/session"
        ? (apiUnavailable ? {} : { accessToken: "test-token" })
        : {
            current_node: "answer",
            mapping: {
              answer: {
                parent: "user",
                message: {
                  author: { role: "assistant" },
                  status: "finished_successfully",
                  content: { parts: ["test answer"] },
                },
              },
              user: { message: { author: { role: "user" }, content: { parts: [wrongApiQuestion ? "unrelated question" : question] } } },
            },
          },
    }),
  });
  const result = await new Promise((resolve) => {
    assert.equal(listener({ type: "ask", id: "test", question, mode }, {}, resolve), true);
  });
  return { result, edits, sent };
}

const legacy = editor({ id: "prompt-textarea" });
const unrelatedDraft = editor({ textContent: "another editor's draft" });
let attempt = await consult([legacy, unrelatedDraft]);
assert.equal(attempt.result.ok, true, "historical id remains preferred");
assert.equal(attempt.result.answer, "test answer");
assert.equal(unrelatedDraft.textContent, "another editor's draft");

const idless = editor();
attempt = await consult([idless]);
assert.equal(attempt.result.ok, true, "id-less ProseMirror composer sends successfully");
assert.equal(attempt.sent, true);
assert.equal(idless.textContent, "");

attempt = await consult([editor({ id: "prompt-textarea", visible: false }), editor()]);
assert.equal(attempt.result.ok, true, "hidden historical editor does not mask visible composer");
attempt = await consult([editor({ visible: false }), editor()]);
assert.equal(attempt.result.ok, true, "hidden editors do not make fallback ambiguous");
attempt = await consult([editor({ nested: true }), editor()]);
assert.equal(attempt.result.ok, true, "inline message/dialog editors are excluded");

for (const candidates of [[], [editor(), editor()], [editor({ visible: false })],
  [editor({ nested: true })], [editor({ composerMarker: false })]]) {
  attempt = await consult(candidates);
  assert.equal(attempt.result.ok, false);
  assert.match(attempt.result.error, /composer not found or ambiguous after 15s/);
  assert.deepEqual(attempt.edits, [], "missing/ambiguous composers must not be edited");
  assert.equal(attempt.sent, false);
}

for (const id of ["prompt-textarea", ""]) {
  const draft = editor({ id, textContent: "keep my draft" });
  attempt = await consult([draft]);
  assert.equal(attempt.result.ok, false);
  assert.match(attempt.result.error, /composer has a draft/);
  assert.equal(draft.textContent, "keep my draft", "rejected drafts survive cleanup");
  assert.deepEqual(attempt.edits, []);
  assert.equal(attempt.sent, false);

  const failed = editor({ id });
  attempt = await consult([failed], { failInsert: true });
  assert.equal(attempt.result.ok, false);
  assert.match(attempt.result.error, /insertText failed/);
  assert.equal(failed.textContent, "", "our failed insertion is cleaned up for either selector");
  assert.equal(attempt.sent, false);
}

const tempDraft = editor({ textContent: "keep temporary draft" });
attempt = await consult([tempDraft], { mode: "temp" });
assert.equal(attempt.result.ok, false);
assert.match(attempt.result.error, /temporary-chat indicator not found/);
assert.equal(tempDraft.textContent, "keep temporary draft");
assert.deepEqual(attempt.edits, []);

for (const layout of ["new", "mixed"]) {
  attempt = await consult([editor()], { layout });
  assert.equal(attempt.result.ok, true, `${layout} message markers verify sending and completion`);
  assert.equal(attempt.result.answer, "test answer");
  attempt = await consult([editor()], { layout, mode: "side-last" });
  assert.equal(attempt.result.ok, true, `${layout} markers support read-only imports`);
  assert.equal(attempt.result.question, question);
  assert.equal(attempt.result.answer, "test answer", "nested markers do not duplicate imported turns");
}
attempt = await consult([editor()], { layout: "unmarked" });
assert.equal(attempt.result.ok, true, "verified API completion does not require assistant DOM markers");
assert.equal(attempt.result.answer, "test answer");
attempt = await consult([editor()], { layout: "unmarked", wrongApiQuestion: true });
assert.equal(attempt.result.ok, false, "API must not return an unrelated answer");
assert.match(attempt.result.error, /no assistant turn started/);
attempt = await consult([editor()], { layout: "new", apiUnavailable: true });
assert.equal(attempt.result.ok, true, "unavailable API still falls back to DOM extraction");
assert.equal(attempt.result.answer, "test answer");

// Temporary chats exercise DOM extraction rather than the conversation API.
attempt = await consult([editor()], { layout: "new", mode: "temp", temporaryIndicator: true });
assert.equal(attempt.result.ok, true);
assert.equal(attempt.result.answer, "test answer");

console.log("content self-check: all assertions passed");
