// Runs in the page's own JS world (MAIN). It wraps the clipboard API so that,
// when the extension "arms" a capture, the next clipboard write made by
// Claude's native Copy button is intercepted and handed to the extension
// instead of overwriting the user's clipboard. Claude's Copy button produces
// the reply's original markdown, which is more faithful than converting HTML.
//
// Arming is done through a data attribute on <html>, because the DOM is shared
// with the extension's isolated world and, unlike postMessage, is synchronous:
// the attribute is set before the Copy button is clicked.
(() => {
  if (window.__cmdCaptureInstalled) return;
  window.__cmdCaptureInstalled = true;

  const clip = navigator.clipboard;
  if (!clip) return;

  const ARM_ATTR = "data-cmd-arm";

  // Returns the armed capture id and disarms, or null if not armed.
  const takeArm = () => {
    const root = document.documentElement;
    const id = root.getAttribute(ARM_ATTR);
    if (id) root.removeAttribute(ARM_ATTR);
    return id;
  };

  const deliver = (id, text) =>
    window.postMessage({ source: "cmd-page", type: "captured", id, text }, "*");

  const origWriteText = clip.writeText ? clip.writeText.bind(clip) : null;
  const origWrite = clip.write ? clip.write.bind(clip) : null;

  if (origWriteText) {
    clip.writeText = function (text) {
      const id = takeArm();
      if (id) {
        deliver(id, String(text));
        return Promise.resolve();
      }
      return origWriteText(text);
    };
  }

  if (origWrite) {
    clip.write = async function (items) {
      const id = takeArm();
      if (id) {
        try {
          for (const item of items || []) {
            const type = item.types.includes("text/plain")
              ? "text/plain"
              : item.types.find((t) => t.startsWith("text/"));
            if (type) {
              const blob = await item.getType(type);
              deliver(id, await blob.text());
              return;
            }
          }
        } catch (_) {
          /* fall through to a normal write */
        }
      }
      return origWrite(items);
    };
  }
})();
