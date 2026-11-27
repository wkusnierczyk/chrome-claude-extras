// Adds two sections to the right-hand rail of a Claude Code session on
// claude.ai/code (beside Environment, Context, Outputs and Changes), from
// what the decide-pane mod and the session write, read through the native
// host by the background worker:
//   Clear      whether the session may be cleared now, as the status line says
//   Questions  the questions the session has asked, by state
// The session is matched by its Remote Control id, the one in the address.
(() => {
  // claude.ai's markup is not a public API. If an update breaks the sections,
  // these selectors are the place to fix it. Their look is copied from the
  // rail's own sections at run time, so it follows the site's styling.
  const SEL = {
    section: "section[data-rail-section]",
    // A section's card. The rail draws the line above a section from this
    // attribute on its card, so the sections' own cards carry it too.
    card: "[data-rail-card]",
    cardAttr: "data-rail-card",
    // The header row, its fold button, and the chevron icon inside it.
    headerRow: ":scope > div:first-child",
    headerButton: "button",
    chevron: 'button > [data-cds="Icon"]',
    // A section's list body, and one row of it, e.g. a file under Outputs.
    listBody: "[data-rail-panel] > div",
    row: "[data-rail-panel] span[role][tabindex]",
    // The section to go after, by its title; else the rail's second.
    anchorTitle: "Context",
    composer: [
      '[data-testid="code-prompt-input"]',
      'div[contenteditable="true"].ProseMirror',
      '[data-testid="chat-input"] [contenteditable="true"]',
      'div[contenteditable="true"]',
    ],
  };
  // The list classes where no section has an open list to copy them from
  // (Outputs and Changes folded), as the rail had them.
  const FALLBACK = {
    listBody: "flex flex-col pt-1 px-sm",
    row: "flex min-h-6.5 w-full min-w-0 items-center gap-sm px-xs text-body rounded hover:bg-fill-ghost-hover",
  };
  // A folded section's chevron points right; an open one's shows on hover.
  const CHEVRON_FOLDED = ["-rotate-90", "page-rtl:rotate-90"];
  const CHEVRON_OPEN = [
    "opacity-0",
    "group-hover/railtop:opacity-100",
    "group-focus-within/railtop:opacity-100",
    "touch:opacity-100",
  ];

  const POLL_MS = 3000;
  const MARK = "data-cce-rail";
  const ORDER = ["clear", "questions"];
  const HEADINGS = { open: "Open", progressing: "Progressing", answered: "Answered" };
  // Replies in a row without the session (its file mid-write) that keep
  // what was shown before it is dropped.
  const KEEP_MISSES = 2;
  // The status line's thresholds (~/.claude/statusline.sh), in tokens.
  const CLEAR_AT = 60000;
  const BOUNDARY_AT = 300000;

  // What is shown, and for which session: nothing is drawn on another
  // session's page, even for the moment before that page's first reply.
  let shownFor = null;
  let session = null; // the host's record of the session, null until found
  let misses = 0; // replies in a row without the session
  let error = "";
  const lastShown = {};
  const isCollapsed = { clear: false, questions: false };
  let isAnsweredOpen = false;
  let isPolling = false;
  let timer = 0;
  let observer = null;

  const sessionId = () => (location.pathname.match(/^\/code\/(session_[A-Za-z0-9]+)/) || [])[1] || null;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of children) {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
  }

  function toast(msg) {
    const node = el("div", { className: "cmd-toast", textContent: msg });
    document.body.appendChild(node);
    setTimeout(() => node.classList.add("cmd-toast-out"), 2200);
    setTimeout(() => node.remove(), 2700);
  }

  function safeLink(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch {
      return null;
    }
  }

  function ago(seconds) {
    const s = Math.max(0, Math.round(Date.now() / 1000 - seconds));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }

  // The visible message box, the last one, as content.js finds it; its
  // editable element where the match is a wrapper.
  function findComposer() {
    for (const sel of SEL.composer) {
      const all = [...document.querySelectorAll(sel)].filter((node) => node.offsetParent !== null);
      if (all.length === 0) continue;
      const box = all[all.length - 1];
      return box.isContentEditable ? box : box.querySelector('[contenteditable="true"]');
    }
    return null;
  }

  // Types "Q<n>: " at the end of the message box without sending, or copies it.
  async function answer(q) {
    const text = `Q${q.n}: `;
    const box = findComposer();
    if (box) {
      box.focus();
      const sel = window.getSelection();
      sel.selectAllChildren(box);
      sel.collapseToEnd();
      const hasText = (box.innerText ?? box.textContent ?? "").trim().length > 0;
      if (document.execCommand("insertText", false, (hasText ? " " : "") + text)) return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied "${text}" — paste it into the prompt`);
    } catch {
      toast("Couldn't reach the message box or the clipboard");
    }
  }

  const titleOf = (section) => section.querySelector(SEL.headerRow)?.querySelector(SEL.headerButton)?.textContent.trim() || "";

  // The rail's own classes, read off a section that has a list (Outputs,
  // Changes), else any section; the chevron from any section.
  function template() {
    const sections = [...document.querySelectorAll(SEL.section)].filter((s) => !s.closest(`[${MARK}]`));
    if (sections.length === 0) return null;
    const withRows = sections.find((s) => s.querySelector(SEL.row)) || sections[0];
    const headerRow = withRows.querySelector(SEL.headerRow);
    const anchor = sections.find((s) => titleOf(s).startsWith(SEL.anchorTitle)) || sections[Math.min(1, sections.length - 1)];
    return {
      anchor: anchor.closest(SEL.card),
      card: withRows.closest(SEL.card)?.className || "",
      section: withRows.className,
      headerRow: headerRow?.className || "",
      headerButton: headerRow?.querySelector(SEL.headerButton)?.className || "",
      chevron: sections.map((s) => s.querySelector(SEL.chevron)).find(Boolean) || null,
      listBody: withRows.querySelector(SEL.listBody)?.className || FALLBACK.listBody,
      row: withRows.querySelector(SEL.row)?.className || FALLBACK.row,
    };
  }

  function chevron(t, collapsed) {
    if (!t.chevron) return null;
    const icon = t.chevron.cloneNode(true);
    icon.classList.remove(...CHEVRON_FOLDED, ...CHEVRON_OPEN);
    icon.classList.add(...(collapsed ? CHEVRON_FOLDED : CHEVRON_OPEN));
    if (collapsed) icon.removeAttribute("data-open");
    else icon.setAttribute("data-open", "");
    return icon;
  }

  // One rail card: a header that folds it, with a short summary beside the
  // title, and its body.
  function card(t, name, title, summary, body) {
    const collapsed = isCollapsed[name];
    const toggle = el(
      "button",
      { className: t.headerButton, type: "button", ariaExpanded: String(!collapsed) },
      el("span", { className: "shrink-0", textContent: title }),
      summary,
      chevron(t, collapsed),
    );
    toggle.addEventListener("click", () => {
      isCollapsed[name] = !isCollapsed[name];
      delete lastShown[name];
      render();
    });
    const section = el(
      "section",
      { className: t.section },
      el("div", { className: t.headerRow }, el("div", { className: "flex min-w-0 flex-1" }, toggle)),
      collapsed ? null : body,
    );
    if (!collapsed) section.setAttribute("data-open", "");
    const node = el("div", { className: t.card }, section);
    node.setAttribute(SEL.cardAttr, "");
    node.setAttribute(MARK, name);
    return node;
  }

  const note = (text, className = "cce-dim") => el("p", { className: `${className} cce-note`, textContent: text });

  // ---------- Clear ----------

  // The status line's rule: the session's own word (busy or done) first,
  // then the context's size, counted 0 when unknown as the status line does.
  function clearVerdict() {
    if (session?.isEnded) return { label: "Session ended", tone: "cce-dim", why: "cleared or quit" };
    const state = session?.clear;
    const tokens = session?.context?.tokens ?? 0;
    if (state?.state === "busy") {
      return { label: "Don't clear yet", tone: "cce-warn", why: state.why };
    }
    if (state?.state === "done") {
      return tokens < CLEAR_AT
        ? { label: "Clear when you like", tone: "cce-ok", why: state.why }
        : { label: "Clear now", tone: "cce-ok", why: state.why };
    }
    if (tokens >= BOUNDARY_AT) {
      return { label: "Clear at the next boundary", tone: "cce-warn", why: "the context is large" };
    }
    return { label: "Nothing recorded", tone: "cce-dim", why: "" };
  }

  function buildClear(t) {
    if (session === null) {
      return card(t, "clear", "Clear", null, el("div", { className: `${t.listBody} cce-body` }, error ? note(error, "cce-warn") : note("Nothing from this session yet.")));
    }
    const verdict = clearVerdict();
    const tokens = session.context?.tokens;
    const facts = session.isEnded
      ? []
      : [
          typeof tokens === "number" ? `context ${Math.round(tokens / 1000)}k` : null,
          typeof session.clear?.at === "number" ? `set ${ago(session.clear.at)}` : null,
        ].filter(Boolean);
    const body = el(
      "div",
      { className: `${t.listBody} cce-body` },
      error ? note(error, "cce-warn") : null,
      el("p", { className: "cce-note cce-clear" }, el("span", { className: verdict.tone, textContent: verdict.label }), verdict.why ? `: ${verdict.why}` : ""),
      facts.length ? note(facts.join(" · ")) : null,
    );
    return card(t, "clear", "Clear", el("span", { className: verdict.tone, textContent: ` ${verdict.label}` }), body);
  }

  // ---------- Questions ----------

  function questionRow(q, t) {
    const link = q.link ? safeLink(q.link) : null;
    const row = el(
      "span",
      { className: `${t.row} cce-q`, role: "button", tabIndex: 0, title: `Answer Q${q.n}` },
      el("span", { className: "cce-q-n", textContent: `Q${q.n}` }),
      el(
        "span",
        { className: "cce-q-text" },
        q.issue ? el("span", { className: "cce-dim", textContent: `${q.issue} ` }) : null,
        q.question,
        q.state === "progressing" && q.note ? el("span", { className: "cce-warn", textContent: ` — still: ${q.note}` }) : null,
        q.state === "answered" && q.note ? el("span", { className: "cce-dim", textContent: ` — ${q.note}` }) : null,
        link ? " " : null,
        link ? el("a", { href: link, target: "_blank", rel: "noopener", textContent: "mock-up" }) : null,
      ),
    );
    row.addEventListener("click", (event) => {
      if (!event.target.closest("a")) answer(q);
    });
    // A held key repeats into the message box once it has the focus, where
    // Enter would send; act on the first press only.
    row.addEventListener("keydown", (event) => {
      if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      if (!event.repeat) answer(q);
    });
    return row;
  }

  function buildQuestions(t) {
    const questions = Array.isArray(session?.questions) && !session.isEnded ? session.questions : null;
    const list = questions || [];
    const byState = (state) => list.filter((q) => q.state === state);
    const pending = byState("open").length + byState("progressing").length;

    const body = el("div", { className: `${t.listBody} cce-body` });
    if (error) body.append(note(error, "cce-warn"));
    if (questions === null) {
      if (!error) body.append(note("No questions from this session yet."));
    } else {
      for (const state of ["open", "progressing"]) {
        const rows = byState(state);
        if (rows.length === 0) continue;
        body.append(el("div", { className: "cce-head", textContent: `${HEADINGS[state]} (${rows.length})` }));
        rows.forEach((q) => body.append(questionRow(q, t)));
      }
      const answered = byState("answered");
      if (answered.length > 0) {
        const details = el(
          "details",
          { open: isAnsweredOpen },
          el("summary", { className: "cce-head", textContent: `Answered (${answered.length})` }),
          ...answered.map((q) => questionRow(q, t)),
        );
        details.addEventListener("toggle", () => (isAnsweredOpen = details.open));
        body.append(details);
      }
      if (list.length === 0) body.append(note("No questions yet."));
    }
    const summary = questions === null ? null : el("span", { className: "cce-dim", textContent: ` ${pending} open` });
    return card(t, "questions", "Questions", summary, body);
  }

  // ---------- placing ----------

  const BUILD = { clear: buildClear, questions: buildQuestions };

  // What each section shows, to redraw it only when that changed. The clear
  // section's ages are coarse enough to redraw on each change of minute.
  function keyOf(name) {
    // Both sections change when the session ends, whatever else stays.
    const common = [shownFor, error, isCollapsed[name], Boolean(session?.isEnded)];
    if (name === "questions") return JSON.stringify([...common, session?.questions ?? null]);
    return JSON.stringify([...common, session?.clear ?? null, session?.context ?? null, Math.floor(Date.now() / 60000)]);
  }

  // Forgets what was shown when the page moved to another session.
  function follow() {
    const id = sessionId();
    if (id === shownFor) return false;
    shownFor = id;
    session = null;
    misses = 0;
    error = "";
    for (const name of ORDER) delete lastShown[name];
    return true;
  }

  // Puts the sections after Context, in order, or redraws one when what it
  // shows changed. A re-render of the rail that drops them puts them back
  // on the next mutation.
  function render() {
    const moved = follow();
    if (!shownFor) {
      document.querySelectorAll(`[${MARK}]`).forEach((node) => node.remove());
      return;
    }
    if (moved) poll();
    const t = template();
    if (!t || !t.anchor) return;
    let after = t.anchor;
    for (const name of ORDER) {
      const existing = document.querySelector(`[${MARK}="${name}"]`);
      const key = keyOf(name);
      if (existing && existing.isConnected && key === lastShown[name]) {
        if (existing.previousElementSibling !== after) after.after(existing);
        after = existing;
        continue;
      }
      lastShown[name] = key;
      const node = BUILD[name](t);
      if (existing) existing.replaceWith(node);
      if (node.previousElementSibling !== after) after.after(node);
      after = node;
    }
  }

  // The extension was reloaded or removed: this copy can no longer reach it,
  // and the new one is not injected into open tabs, so step aside.
  function retire() {
    clearInterval(timer);
    observer?.disconnect();
    document.querySelectorAll(`[${MARK}]`).forEach((node) => node.remove());
  }

  function poll() {
    const id = sessionId();
    if (!id || isPolling || document.hidden) return;
    if (!chrome.runtime?.id) {
      retire();
      return;
    }
    isPolling = true;
    try {
      chrome.runtime.sendMessage({ type: "session", bridgeSessionId: id }, (reply) => {
        isPolling = false;
        if (id !== sessionId()) return;
        if (chrome.runtime.lastError || !reply || reply.error) {
          // Keep what is shown; say why it is not updating.
          error = `Not updating: ${chrome.runtime.lastError?.message || reply?.error || "no reply"}`;
        } else {
          // The mod could not refresh the list: show the one it kept, and why.
          const why = reply.session && !reply.session.isEnded && typeof reply.session.error === "string" ? reply.session.error : "";
          error = why && why[0].toUpperCase() + why.slice(1);
          // A session missing from a reply or two (its file mid-write) keeps
          // what it showed; longer, it is gone.
          misses = reply.session ? 0 : misses + 1;
          if (reply.session || misses > KEEP_MISSES) session = reply.session || null;
        }
        render();
      });
    } catch {
      isPolling = false;
      retire();
    }
  }

  let scheduled = 0;
  observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = 0;
      for (const name of ORDER) {
        if (!document.querySelector(`[${MARK}="${name}"]`)) delete lastShown[name];
      }
      render();
    }, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  timer = setInterval(() => {
    follow();
    poll();
  }, POLL_MS);
  document.addEventListener("visibilitychange", poll);
  poll();
})();
