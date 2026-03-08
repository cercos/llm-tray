const { ipcRenderer, shell } = require("electron");

function isSafeExternalUrl(rawUrl, { allowMailto = false } = {}) {
  if (typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 4096) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return true;
    if (allowMailto && parsed.protocol === "mailto:") return true;
    return false;
  } catch {
    return false;
  }
}

function notifyHost(channel) {
  try {
    ipcRenderer.sendToHost(channel, Date.now());
  } catch {}
}

function openLinkExternally(e) {
  if (!e.isTrusted) return;
  const target = e.target instanceof Element ? e.target : null;
  const a = target ? target.closest("a[href]") : null;
  if (!a) return;
  if (!isSafeExternalUrl(a.href, { allowMailto: true })) return;
  e.preventDefault();
  e.stopPropagation();
  shell.openExternal(a.href);
}

// Keep host menus in sync when users click inside webview content.
window.addEventListener("pointerdown", () => notifyHost("guest-pointerdown"), true);
window.addEventListener("contextmenu", () => notifyHost("guest-contextmenu"), true);

// Optional browser-like behavior for external opening.
window.addEventListener("auxclick", (e) => {
  if (e.button === 1) openLinkExternally(e);
});

window.addEventListener("click", (e) => {
  if (e.ctrlKey || e.metaKey) openLinkExternally(e);
});

window.addEventListener(
  "keydown",
  (e) => {
    if (e.repeat) return;
    if (e.key === "F12") {
      notifyHost("guest-open-devtools");
      return;
    }
    const isNewTab = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey &&
      e.key.toLowerCase() === "t";
    if (!isNewTab) return;
    e.preventDefault();
    e.stopPropagation();
    notifyHost("guest-new-tab");
  },
  true,
);
