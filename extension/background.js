// The toolbar button opens the Questions side panel. Set at every start of
// the worker as well as on install, so it holds after a browser restart.
function openPanelOnClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
}

chrome.runtime.onInstalled.addListener(openPanelOnClick);
openPanelOnClick();

const HOST = "com.wkusnierczyk.claude_extras";

// The rail section (questions.js) asks for one session's questions by its
// Remote Control id; content scripts cannot reach the native host themselves.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "questions" || typeof message.bridgeSessionId !== "string") return false;
  chrome.runtime.sendNativeMessage(HOST, { type: "list" }, (reply) => {
    if (chrome.runtime.lastError || !reply || !Array.isArray(reply.sessions)) {
      sendResponse({ error: chrome.runtime.lastError?.message || "no reply" });
      return;
    }
    const session = reply.sessions.find((s) => s.bridgeSessionId === message.bridgeSessionId);
    sendResponse({ questions: session ? session.questions : null });
  });
  return true;
});
