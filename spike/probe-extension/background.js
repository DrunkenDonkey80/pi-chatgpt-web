// Probe background: capabilities, native relay (one-shot), temp-chat tab.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg === "probe") {
    sendResponse({
      connectNative: typeof chrome.runtime.connectNative === "function",
      sendNativeMessage: typeof chrome.runtime.sendNativeMessage === "function",
      manifestPerms: chrome.runtime.getManifest().permissions || [],
    });
    return;
  }
  if (msg === "open-temp") {
    chrome.tabs.create({ url: "https://chatgpt.com/?temporary-chat=true" });
    sendResponse({ opened: true });
    return;
  }
  if (msg && msg.msg === "relay") {
    chrome.runtime.sendNativeMessage(
      "com.flex.pichatgptprobe",
      msg.payload,
      (resp) => {
        sendResponse({
          resp,
          lastError: chrome.runtime.lastError
            ? chrome.runtime.lastError.message
            : null,
        });
      },
    );
    return true; // async sendResponse
  }
});
