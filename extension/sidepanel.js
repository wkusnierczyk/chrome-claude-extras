// The Questions side panel: the questions a Claude Code session has asked,
// as the decide-pane mod writes them, read through the native host.

const HOST = "com.wkusnierczyk.claude_extras";
const POLL_MS = 3000;
const HEADINGS = { open: "Open", progressing: "Progressing", answered: "Answered" };

const sessionSelect = document.getElementById("session");
const updated = document.getElementById("updated");
const message = document.getElementById("message");
const list = document.getElementById("list");
const toast = document.getElementById("toast");

// Follow the latest-updated session until the person picks one.
let pickedId = null;
let isAnsweredOpen = false;
let lastRendered = "";

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function sessionName(session) {
  const remote = session.repo || "";
  const match = remote.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
  if (match) return match[1];
  const root = session.root || session.sessionId || "session";
  return root.split("/").filter(Boolean).pop() || root;
}

function ago(seconds) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - seconds));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function showMessage(text, isError = false) {
  message.hidden = text === "";
  message.className = isError ? "error" : "";
  message.replaceChildren(...(Array.isArray(text) ? text : [text]));
}

let toastTimer = 0;
function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 2000);
}

function safeLink(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function questionRow(q) {
  const link = q.link ? safeLink(q.link) : null;
  const row = el(
    "button",
    { className: "q", type: "button", title: `Copy "Q${q.n}: " to answer it` },
    el("span", { className: "n", textContent: `Q${q.n}` }),
    q.issue ? el("span", { className: "issue", textContent: `${q.issue} ` }) : null,
    q.question,
    q.state === "progressing" && q.note
      ? el("span", { className: "still", textContent: ` — still: ${q.note}` })
      : null,
    q.state === "answered" && q.note
      ? el("span", { className: "answer", textContent: ` — ${q.note}` })
      : null,
    link ? " " : null,
    link ? el("a", { href: link, target: "_blank", rel: "noopener", textContent: "mock-up" }) : null,
  );
  row.addEventListener("click", async (event) => {
    if (event.target.closest("a")) return;
    try {
      await navigator.clipboard.writeText(`Q${q.n}: `);
      showToast(`Copied "Q${q.n}: " — paste it into the prompt`);
    } catch {
      showToast("Could not copy to the clipboard");
    }
  });
  return row;
}

function render(sessions) {
  const key = JSON.stringify([sessions, pickedId]);
  if (key === lastRendered) {
    if (sessions.length > 0) updated.textContent = ago(current(sessions).modifiedAt);
    return;
  }
  lastRendered = key;

  if (sessions.length === 0) {
    sessionSelect.replaceChildren();
    sessionSelect.disabled = true;
    updated.textContent = "";
    list.replaceChildren();
    showMessage("No Claude Code session with the decide-pane mod has written its questions yet.");
    return;
  }

  const session = current(sessions);
  sessionSelect.disabled = false;
  sessionSelect.replaceChildren(
    ...sessions.map((s) =>
      el("option", {
        value: s.sessionId,
        selected: s.sessionId === session.sessionId,
        textContent: `${sessionName(s)} · ${s.sessionId.slice(0, 8)}`,
      }),
    ),
  );
  updated.textContent = ago(session.modifiedAt);
  showMessage(session.error || "", Boolean(session.error));

  const questions = Array.isArray(session.questions) ? session.questions : [];
  const byState = (state) => questions.filter((q) => q.state === state);
  const sections = [];
  for (const state of ["open", "progressing"]) {
    const rows = byState(state);
    if (rows.length === 0) continue;
    sections.push(el("h2", { textContent: `${HEADINGS[state]} (${rows.length})` }), ...rows.map(questionRow));
  }
  const answered = byState("answered");
  if (answered.length > 0) {
    const details = el(
      "details",
      { open: isAnsweredOpen },
      el("summary", { textContent: `Answered (${answered.length})` }),
      ...answered.map(questionRow),
    );
    details.addEventListener("toggle", () => (isAnsweredOpen = details.open));
    sections.push(details);
  }
  if (questions.length === 0) sections.push(el("p", { textContent: "No questions in this session yet." }));
  list.replaceChildren(...sections);
}

function current(sessions) {
  return sessions.find((s) => s.sessionId === pickedId) || sessions[0];
}

sessionSelect.addEventListener("change", () => {
  pickedId = sessionSelect.value;
  poll();
});

function poll() {
  chrome.runtime.sendNativeMessage(HOST, { type: "list" }, (reply) => {
    if (chrome.runtime.lastError || !reply) {
      lastRendered = "";
      list.replaceChildren();
      sessionSelect.replaceChildren();
      sessionSelect.disabled = true;
      updated.textContent = "";
      showMessage(
        [
          "Cannot reach the native host. Run ",
          el("code", { textContent: "host/install.sh" }),
          " from the extension's repository, then reopen this panel. ",
          `(${chrome.runtime.lastError?.message || "no reply"})`,
        ],
        true,
      );
      return;
    }
    if (reply.error) {
      showMessage(reply.error, true);
      return;
    }
    render(reply.sessions || []);
  });
}

poll();
setInterval(poll, POLL_MS);
