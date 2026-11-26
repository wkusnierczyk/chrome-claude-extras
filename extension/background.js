// The toolbar button opens the Questions side panel. Set at every start of
// the worker as well as on install, so it holds after a browser restart.
function openPanelOnClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
}

chrome.runtime.onInstalled.addListener(openPanelOnClick);
openPanelOnClick();
