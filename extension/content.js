// Content script: performs one ask = fill composer → send → verify OUR turn
// appeared → wait for completion → extract DOM→markdown. M1-proven flow.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // whitespace-insensitive compare: the composer's textContent drops the
  // newlines we inserted ENTIRELY (paragraph breaks contribute no character
  // — not even a space), so strip all whitespace on both sides, never
  // collapse-and-compare
  const norm = (s) => (s || "").replace(/\s+/g, "");
  const turns = () =>
    document.querySelectorAll('[data-message-author-role="assistant"]').length;

  let chip = null;
  const status = (t) => {
    if (!chip) {
      chip = document.createElement("div");
      chip.style.cssText =
        "position:fixed;bottom:0;left:0;z-index:2147483647;background:#0c6;color:#000;padding:4px 10px;font:12px monospace;border-top-right-radius:6px";
      document.body.appendChild(chip);
    }
    chip.textContent = `pi: ${t}`;
  };
  const clearChip = () => {
    const c = chip;
    chip = null;
    setTimeout(() => c && c.remove(), 10000);
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "ping") {
      sendResponse({ pong: true, url: location.href });
      return;
    }
    if (msg && msg.type === "ask") {
      ask(msg.id, msg.question, msg.mode, msg.attachments)
        .then(sendResponse)
        .catch((e) =>
          sendResponse({
            ok: false,
            error: String(e && e.message ? e.message : e),
          }),
        );
      return true; // async response
    }
  });

  async function ask(_id, question, mode, attachments) {
    try {
      const q = question;
      if (mode === "side-last") {
        // extract-only: no send, no composer needed. Wait out any running
        // generation first so we never grab a half-streamed answer.
        const stopSel = 'button[data-testid="stop-button"]';
        const st = Date.now();
        while (document.querySelector(stopSel) && Date.now() - st < 300000)
          await sleep(500);
        const users = document.querySelectorAll(
          '[data-message-author-role="user"]',
        );
        const asst = document.querySelectorAll(
          '[data-message-author-role="assistant"]',
        );
        const u = users[users.length - 1];
        const a = asst[asst.length - 1];
        if (!a)
          throw new Error("no assistant message in the side discussion yet");
        status("extracted last exchange");
        return {
          ok: true,
          url: location.href,
          question: u ? (u.innerText || "").trim() : "(no user turn found)",
          answer: domToMarkdown(a),
        };
      }
      const prevCount = turns();
      // the composer mounts after React hydrates — poll for it (fresh tabs hit
      // this every time; readyState=interactive has only a fallback textarea)
      status("waiting for composer…");
      let composer = null;
      const tw = Date.now();
      while (Date.now() - tw < 15000) {
        composer = document.querySelector("#prompt-textarea");
        if (composer) break;
        await sleep(300);
      }
      if (!composer) {
        const cands = [
          ...document.querySelectorAll('textarea, [contenteditable="true"]'),
        ]
          .slice(0, 8)
          .map(
            (e) =>
              `<${e.tagName.toLowerCase()} id=${JSON.stringify(e.id)} ce=${e.getAttribute("contenteditable")} cls=${JSON.stringify((e.className || "").toString().slice(0, 60))}>`,
          )
          .join(" ");
        throw new Error(
          `composer #prompt-textarea not found after 15s; readyState=${document.readyState}; candidates: ${cands || "NONE"}`,
        );
      }
      if (mode === "temp") {
        // refuse to send anywhere that is not a verified temporary chat
        await sleep(500);
        if (!document.body.innerText.includes("Temporary chat"))
          throw new Error(
            "temporary-chat indicator not found — refusing to send to a normal chat",
          );
      }
      const draft = (composer.textContent || "").trim();
      if (draft)
        throw new Error(
          `composer has a draft (${draft.length} chars) — refusing to overwrite; clear it in the tab first`,
        );
      if (attachments?.length) {
        status("attaching files…");
        // the file input is lazy: click the paperclip once to materialize it
        let input = null;
        for (let i = 0; i < 20 && !input; i++) {
          input = document.querySelector('input[type="file"]');
          if (!input) {
            if (i === 3)
              document
                .querySelector(
                  'button[data-testid="composer-attach-button"], button[aria-label*="ttach"]',
                )
                ?.click();
            await sleep(300);
          }
        }
        if (!input) throw new Error("composer file input not found");
        const dt = new DataTransfer();
        for (const a of attachments) {
          const bytes = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0));
          dt.items.add(
            new File([bytes], a.name, {
              type: a.type || "application/octet-stream",
            }),
          );
        }
        input.files = dt.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(1500); // upload chips must render before send enables
      }
      status("filling composer…");
      composer.focus();
      document.execCommand("selectAll");
      document.execCommand("delete");
      if (!document.execCommand("insertText", false, q))
        throw new Error("insertText failed");
      // let React/ProseMirror commit the insertion before touching send
      await sleep(300);
      const readback = (composer.textContent || "").trim();
      if (!norm(readback).startsWith(norm(q).slice(0, 40)))
        throw new Error(
          `composer readback mismatch: "${readback.slice(0, 40)}"`,
        );
      const diag = [`filled=${readback.length}ch`];

      status("sending…");
      const candidates = [
        'button[data-testid="send-button"]',
        'button[data-testid="composer-sent-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send"]',
        'form button[type="submit"]',
      ];
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
      let sent = false;
      for (let i = 0; i < 10 && !sent; i++) {
        for (const sel of candidates) {
          const btn = document.querySelector(sel);
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

      // verify OUR question was actually sent: last user turn must start with
      // the question prefix and the composer must have cleared
      status("verifying our turn…");
      const qPrefix = norm(q).slice(0, 60);
      let t0 = Date.now();
      let enterRetryTried = false;
      let userTurn = null;
      while (Date.now() - t0 < 30000) {
        const users = document.querySelectorAll(
          '[data-message-author-role="user"]',
        );
        userTurn = users.length ? users[users.length - 1] : null;
        const okTurn = userTurn && norm(userTurn.innerText).startsWith(qPrefix);
        if (okTurn && !(composer.textContent || "").trim()) break;
        if (!enterRetryTried && Date.now() - t0 > 8000) {
          enterRetryTried = true;
          enterFallback();
          diag.push("enter-retry");
        }
        await sleep(400);
      }
      const lastUser = userTurn ? (userTurn.innerText || "").trim() : "";
      if (!norm(lastUser).startsWith(qPrefix))
        throw new Error(
          `send verification failed — last user turn: "${lastUser.slice(0, 60)}"; composer: "${(composer.textContent || "").slice(0, 40)}"; diag: ${diag.join(", ")}`,
        );

      status("waiting for the answer…");
      // Thinking models can reason for 5+ minutes before any assistant DOM
      // node exists — the stop button is the reliable "generation started"
      // signal, so accept either it or the new turn appearing.
      const stopSel = 'button[data-testid="stop-button"]';
      const started = () =>
        turns() > prevCount || !!document.querySelector(stopSel);
      t0 = Date.now();
      while (!started() && Date.now() - t0 < 180000) await sleep(500);
      if (!started())
        throw new Error(
          "no assistant turn started within 180s — question rejected or ChatGPT stuck?",
        );
      t0 = Date.now();
      while (document.querySelector(stopSel) && Date.now() - t0 < 900000)
        await sleep(500);

      status("checking stability…");
      let last = "";
      let same = 0;
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
      if (!el) throw new Error("no assistant message to extract");
      const answer = domToMarkdown(el);
      status("done");
      return { ok: true, url: location.href, question: q, answer };
    } finally {
      clearChip();
      // a failed ask must not leave our draft wedged in the composer — the
      // next ask refuses to overwrite a draft, so clear ours on the way out
      try {
        const c = document.querySelector("#prompt-textarea");
        if (c && (c.textContent || "").trim()) {
          c.focus();
          document.execCommand("selectAll");
          document.execCommand("delete");
        }
      } catch {}
    }
  }

  // --- DOM → markdown walker (ChatGPT renderer structure, M1-verified) ---
  function domToMarkdown(root) {
    const out = [];
    const skip = (t) =>
      t === "BUTTON" || t === "SVG" || t === "SCRIPT" || t === "STYLE";
    const inline = (node) => {
      let s = "";
      for (const n of node.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) s += n.textContent;
        else if (n.nodeType === Node.ELEMENT_NODE) {
          const t = n.tagName;
          if (skip(t)) continue;
          if (t === "BR") s += "\n";
          else if (t === "CODE") s += "`" + inline(n) + "`";
          else if (t === "STRONG" || t === "B") s += "**" + inline(n) + "**";
          else if (t === "EM" || t === "I") s += "*" + inline(n) + "*";
          else if (t === "A")
            s += `[${inline(n)}](${n.getAttribute("href") || ""})`;
          else s += inline(n);
        }
      }
      return s;
    };
    const pre = (n) => {
      const lang =
        n.querySelector("div.font-medium")?.textContent?.trim() || "";
      const code =
        n.querySelector("pre.cm-content")?.innerText ?? n.innerText ?? "";
      out.push("```" + lang + "\n" + code.replace(/\n+$/, "") + "\n```");
    };
    const list = (el, depth, ordered) => {
      let i = 1;
      for (const li of el.children) {
        if (li.tagName !== "LI") continue;
        const nested = [...li.children].filter(
          (c) => c.tagName === "UL" || c.tagName === "OL",
        );
        const head = document.createElement("div");
        for (const c of [...li.children])
          if (!nested.includes(c)) head.appendChild(c.cloneNode(true));
        out.push(
          "  ".repeat(depth) +
            (ordered ? `${i++}. ` : "- ") +
            inline(head).trim(),
        );
        for (const nl of nested) list(nl, depth + 1, nl.tagName === "OL");
      }
    };
    const table = (el) => {
      const rows = [...el.querySelectorAll("tr")];
      if (!rows.length) return;
      const cells = (tr) =>
        [...tr.children].map((c) => inline(c).trim().replace(/\|/g, "\\|"));
      const head = cells(rows[0]);
      out.push("| " + head.join(" | ") + " |");
      out.push("| " + head.map(() => "---").join(" | ") + " |");
      for (const tr of rows.slice(1))
        out.push("| " + cells(tr).join(" | ") + " |");
    };
    const block = (el, depth) => {
      for (const n of el.children) {
        const t = n.tagName;
        if (skip(t)) continue;
        if (t === "PRE") pre(n);
        else if (t === "UL" || t === "OL") list(n, depth, t === "OL");
        else if (t === "TABLE") table(n);
        else if (/^H[1-6]$/.test(t))
          out.push("#".repeat(+t[1]) + " " + inline(n).trim());
        else if (t === "P") out.push(inline(n).trim());
        else if (t === "BLOCKQUOTE") out.push("> " + inline(n).trim());
        else if (t === "HR") out.push("---");
        else if (t === "DIV") block(n, depth);
      }
    };
    const md = root.querySelector(".markdown") || root;
    block(md, 0);
    return out
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
})();
