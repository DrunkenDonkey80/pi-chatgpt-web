// M1 probe: in-page send/completion/extract on chatgpt.com, result relayed via native host.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const turns = () =>
    document.querySelectorAll('[data-message-author-role="assistant"]').length;

  const info = await chrome.runtime
    .sendMessage("probe")
    .catch((e) => ({ error: String(e) }));
  const b = document.createElement("div");
  b.style.cssText =
    "position:fixed;bottom:0;left:0;z-index:2147483647;background:#0c6;color:#000;padding:6px 10px;font:12px monospace;border-top-right-radius:6px;max-width:90vw";
  const mkBtn = (label) => {
    const el = document.createElement("button");
    el.textContent = label;
    el.style.cssText =
      "display:inline-block;margin:4px 6px 0 0;padding:2px 8px;cursor:pointer";
    return el;
  };
  const status = document.createElement("div");
  status.style.cssText = "margin-top:4px;white-space:pre-wrap";

  const tempNote = location.search.includes("temporary-chat")
    ? ` | TEMP URL yes; page says "Temporary chat": ${document.body.innerText.includes("Temporary chat")}`
    : "";
  const infoEl = document.createElement("div");
  infoEl.textContent = `PI-PROBE M1 — ${location.host}${tempNote} — ${JSON.stringify(info)}`;

  async function runM1() {
    try {
      status.textContent = "running…";
      const q = `Browser automation probe at ${new Date().toISOString()}. Reply with exactly these four items and nothing else: 1) a fenced code block containing a tiny Python function, 2) a bullet list with one nested sub-item, 3) a two-column markdown table with one row, 4) one markdown link.`;
      const prevCount = turns();
      const composer = document.querySelector("#prompt-textarea");
      if (!composer) throw new Error("composer #prompt-textarea not found");
      composer.focus();
      document.execCommand("selectAll");
      document.execCommand("delete");
      if (!document.execCommand("insertText", false, q))
        throw new Error("insertText failed");
      // let React/ProseMirror commit the insertion before touching send
      await sleep(300);
      const readback = (composer.textContent || "").trim();
      if (!readback.startsWith(q.slice(0, 20)))
        throw new Error(
          `composer readback mismatch: "${readback.slice(0, 40)}"`,
        );
      const diag = [`filled=${readback.length}ch`];
      status.textContent = "composer filled; finding send button…";
      const candidates = [
        'button[data-testid="send-button"]',
        'button[data-testid="composer-sent-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send"]',
        'form button[type="submit"]',
      ];
      let sent = false;
      const enterFallback = () =>
        composer.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
      for (let i = 0; i < 10 && !sent; i++) {
        for (const sel of candidates) {
          const btn = document.querySelector(sel);
          if (btn) diag.push(`${sel}:${btn.disabled ? "disabled" : "enabled"}`);
          if (btn && !btn.disabled) {
            btn.click();
            sent = true;
            diag.push(`clicked:${sel}`);
            break;
          }
        }
        if (!sent) await sleep(300);
      }
      if (!sent) {
        enterFallback();
        diag.push("enter-fallback");
      }
      status.textContent = `send: ${diag.join(", ")} — verifying our turn…`;
      // verify OUR question was actually sent: the last user turn must start
      // with the question prefix and the composer must have cleared. Never
      // extract a turn we didn't provoke.
      const qPrefix = q.slice(0, 40);
      let t0 = Date.now();
      let enterRetryTried = false;
      let userTurn = null;
      while (Date.now() - t0 < 30000) {
        const users = document.querySelectorAll(
          '[data-message-author-role="user"]',
        );
        userTurn = users.length ? users[users.length - 1] : null;
        const okTurn =
          userTurn && (userTurn.innerText || "").trim().startsWith(qPrefix);
        if (okTurn && !(composer.textContent || "").trim()) break;
        if (!enterRetryTried && Date.now() - t0 > 8000) {
          enterRetryTried = true;
          enterFallback();
          diag.push("enter-retry");
        }
        await sleep(400);
      }
      const lastUser = userTurn ? (userTurn.innerText || "").trim() : "";
      if (!lastUser.startsWith(qPrefix))
        throw new Error(
          `send verification failed — last user turn: "${lastUser.slice(0, 60)}"; composer: "${(composer.textContent || "").slice(0, 40)}"; diag: ${diag.join(", ")}`,
        );
      status.textContent = "our question is on the page; waiting for answer…";
      // wait for OUR assistant turn to appear
      t0 = Date.now();
      while (turns() <= prevCount && Date.now() - t0 < 120000) await sleep(500);
      if (turns() <= prevCount) {
        const btns = [...document.querySelectorAll("button")]
          .map(
            (b) =>
              `${b.getAttribute("data-testid") || b.getAttribute("aria-label") || "?"}${b.disabled ? ":disabled" : ""}`,
          )
          .filter((s) => /send|submit|stop|mic|dictate/i.test(s));
        throw new Error(
          `no new assistant turn within 120s; diag: ${diag.join(", ")}; buttons: ${btns.join(" | ")}`,
        );
      }
      status.textContent = "turn appeared; waiting for generation to finish…";
      // stop button may appear briefly, then vanish
      const stopSel = 'button[data-testid="stop-button"]';
      t0 = Date.now();
      while (!document.querySelector(stopSel) && Date.now() - t0 < 15000)
        await sleep(250);
      t0 = Date.now();
      while (document.querySelector(stopSel) && Date.now() - t0 < 300000)
        await sleep(500);
      // content stability
      let last = "",
        same = 0;
      for (let i = 0; i < 60; i++) {
        const els = document.querySelectorAll(
          '[data-message-author-role="assistant"]',
        );
        const txt = els.length ? els[els.length - 1].innerText : "";
        if (txt && txt === last) {
          if (++same >= 3) break;
        } else same = 0;
        last = txt;
        await sleep(1500);
      }
      const els = document.querySelectorAll(
        '[data-message-author-role="assistant"]',
      );
      const el = els[els.length - 1];
      const result = {
        type: "m1-result",
        url: location.href,
        question: q,
        assistantTurns: turns(),
        innerText: el ? el.innerText : null,
        outerHTML: el ? el.outerHTML.slice(0, 100000) : null,
        ts: Date.now(),
      };
      const resp = await chrome.runtime.sendMessage({
        msg: "relay",
        payload: result,
      });
      status.textContent = `DONE — host reply: ${JSON.stringify(resp).slice(0, 300)}`;
    } catch (e) {
      status.textContent = `M1 ERROR: ${String(e)}`;
    }
  }

  const send = mkBtn("RUN M1 SEND");
  send.addEventListener("click", runM1);
  const temp = mkBtn("OPEN TEMP CHAT");
  temp.addEventListener("click", () => chrome.runtime.sendMessage("open-temp"));
  b.append(infoEl, send, temp, status);
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 30 * 60 * 1000);
})();
