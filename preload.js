const { contextBridge, ipcRenderer, shell } = require("electron");

/* -------------------------------------------------------
   Exposed API
------------------------------------------------------- */
contextBridge.exposeInMainWorld("electronAPI", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (d) => ipcRenderer.invoke("save-settings", d),
  refreshTray: () => ipcRenderer.invoke("refresh-tray"),
  checkAutostart: () => ipcRenderer.invoke("check-autostart"),
  getLastURL: () => ipcRenderer.invoke("get-last-url"),
  setLastURL: (u) => ipcRenderer.invoke("set-last-url", u),
  setCaptureMode: (e) => ipcRenderer.invoke("set-capture-mode", e),
  loadLLM: (url) => ipcRenderer.invoke("load-llm", url),
  openSettingsTray: () => ipcRenderer.invoke("open-settings-tray"),
  openSettingsOverlay: () => ipcRenderer.invoke("open-settings-overlay"),
  openNewWindow: (url) => ipcRenderer.invoke("open-new-window", url),
  getDownloadsPath: () => ipcRenderer.invoke("get-downloads-path"),
  getDownloadTracker: () => ipcRenderer.invoke("get-download-tracker"),
  openDownloadsFolder: () => ipcRenderer.invoke("open-downloads-folder"),
  openDownloadItem: (id) => ipcRenderer.invoke("open-download-item", id),
  cancelDownloadItem: (id) => ipcRenderer.invoke("cancel-download-item", id),
  clearFinishedDownloads: () => ipcRenderer.invoke("clear-finished-downloads"),
  setZoomLevel: (level) => ipcRenderer.invoke("set-zoom-level", level),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window-toggle-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  getWindowMaximized: () => ipcRenderer.invoke("get-window-maximized"),
  getWindowBounds: () => ipcRenderer.invoke("get-window-bounds"),
  setWindowPosition: (position) => ipcRenderer.invoke("set-window-position", position),
  setWindowOpacity: (opacity) => ipcRenderer.invoke("set-window-opacity", opacity),
  getWindowId: () => ipcRenderer.invoke("get-window-id"),
  consumeTabWindowInit: () => ipcRenderer.invoke("consume-tab-window-init"),
  beginTabDragSession: (payload) => ipcRenderer.invoke("begin-tab-drag-session", payload),
  getTabDragSession: () => ipcRenderer.invoke("get-tab-drag-session"),
  clearTabDragSession: (payload) => ipcRenderer.invoke("clear-tab-drag-session", payload),
  openNewTabWindow: (tabData) => ipcRenderer.invoke("open-new-tab-window", tabData),
  completeTabTransfer: (payload) => ipcRenderer.invoke("complete-tab-transfer", payload),
  onOpenLLMTab: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("open-llm-tab", listener);
    return () => ipcRenderer.removeListener("open-llm-tab", listener);
  },
  onWindowMaximized: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, maximized) => callback(!!maximized);
    ipcRenderer.on("window-maximized", listener);
    return () => ipcRenderer.removeListener("window-maximized", listener);
  },
  onTabTransferRemove: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, tabId) => callback(tabId);
    ipcRenderer.on("tab-transfer-remove", listener);
    return () => ipcRenderer.removeListener("tab-transfer-remove", listener);
  },
  onLoadLLMList: (callback) => {
    ipcRenderer.on("load-llm-list", (_e, llms) => callback(llms));
  },
});

/* -------------------------------------------------------
   Theme sync
------------------------------------------------------- */
ipcRenderer.on("theme-updated", (_e, isDark) => {
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
});

/* -------------------------------------------------------
   DRAG & DROP GATE (Optimized for Images & Dist Build)
------------------------------------------------------- */
function isAllowedDrag(e) {
  const dt = e.dataTransfer;
  if (!dt || !dt.types) return false;

  const types = Array.from(dt.types);
  if (
    types.includes("application/x-llmtray-tab") ||
    types.includes("application/x-llmtray-tab+json")
  ) {
    return true;
  }
  if (types.includes("text/plain") || types.includes("text/uri-list")) {
    try {
      const text = dt.getData("text/plain");
      if (!text || text.startsWith("llmtray-tab:")) return true;
    } catch {
      return true;
    }
  }
  // Allows local files, browser images (HTML), and specific image types
  return types.includes("Files") || types.includes("text/html") || types.some(t => t.includes("image"));
}

function dragGate(e) {
  if (!isAllowedDrag(e)) {
    e.preventDefault();
    e.stopPropagation();
    try {
      e.dataTransfer.dropEffect = "none";
      e.dataTransfer.effectAllowed = "none";
    } catch (err) {}
    return false;
  }
}

function openLinkExternally(e) {
  const a = e.target.closest("a[href]");
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  shell.openExternal(a.href);
}

function notifyHost(channel) {
  try {
    ipcRenderer.sendToHost(channel, Date.now());
  } catch {}
}

// Middle mouse button
window.addEventListener("auxclick", (e) => {
  if (e.button === 1) openLinkExternally(e);
});

// Ctrl+Click / Cmd+Click
window.addEventListener("click", (e) => {
  if (e.ctrlKey || e.metaKey) openLinkExternally(e);
});

// Let tab-host UI close floating menus when users interact inside a webview.
window.addEventListener("pointerdown", () => notifyHost("guest-pointerdown"), true);
window.addEventListener("contextmenu", () => notifyHost("guest-contextmenu"), true);

// CRITICAL: We use 'true' (capture phase) to prevent the freeze in production builds
["dragenter", "dragover"].forEach((type) => {
  window.addEventListener(type, dragGate, true);
});

/* -------------------------------------------------------
   Click tracking
------------------------------------------------------- */
window.addEventListener("click", (e) => {
  if (e.defaultPrevented) return;

  if (!window.electronAPI?.setLastURL) return;
  const el = e.target.closest("a[href]");
  if (!el) return;
  const href = el.href;
  if (href && href.startsWith("http") && !href.includes("#")) {
    window.electronAPI.setLastURL(href);
  }
});

/* -------------------------------------------------------
   Context menu
   Allowing bubbling so main.js can handle the custom menu
------------------------------------------------------- */
window.addEventListener(
  "contextmenu",
  (e) => {
    // Bubbling allowed
  },
  false,
);



/* -------------------------------------------------------
   Cleanup for bot detectors
------------------------------------------------------- */
window.addEventListener("DOMContentLoaded", () => {
  try {
    if (window.ipcRenderer) delete window.ipcRenderer;
    if (window.electron) delete window.electron;
  } catch (e) {}
});

/* -------------------------------------------------------
   Layout Kickstart (non-invasive)
------------------------------------------------------- */
window.addEventListener("DOMContentLoaded", () => {
  // Nudge layouts that depend on post-load measurements without changing
  // site scroll APIs or forcing overflow rules.
  const kickstart = () => {
    window.dispatchEvent(new Event("resize"));
  };

  setTimeout(kickstart, 350);
  setTimeout(kickstart, 1200);
});

/* -------------------------------------------------------
   ChatGPT Gallery Fix (targeted)
------------------------------------------------------- */
window.addEventListener("DOMContentLoaded", () => {
  const host = window.location.hostname.toLowerCase();
  if (!host.includes("chatgpt.com")) return;

  const ACTIVE_SELECTORS = [
    '[aria-current="true"]',
    '[aria-selected="true"]',
    '[data-state="active"]',
    '[data-active="true"]',
  ];
  const OBSERVED_ATTRS = [
    "aria-current",
    "aria-selected",
    "data-state",
    "data-active",
    "class",
  ];
  let rafId = 0;
  let timerId = 0;

  const isVisible = (el) => {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };

  const findHorizontalScroller = (el) => {
    let node = el;
    while (node && node !== document.body) {
      if (node.scrollWidth > node.clientWidth + 16) {
        const ox = getComputedStyle(node).overflowX;
        if (ox !== "hidden") return node;
      }
      node = node.parentElement;
    }
    return null;
  };

  const findActiveTarget = () => {
    const candidates = document.querySelectorAll(ACTIVE_SELECTORS.join(","));
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const scroller = findHorizontalScroller(el);
      if (scroller) return { target: el, scroller };
    }
    if (document.activeElement instanceof Element) {
      const scroller = findHorizontalScroller(document.activeElement);
      if (scroller) {
        return { target: document.activeElement, scroller };
      }
    }
    return null;
  };

  const centerTarget = (target, scroller) => {
    try {
      target.scrollIntoView({
        block: "nearest",
        inline: "center",
        behavior: "smooth",
      });
    } catch {}

    const t = target.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const delta = t.left + t.width / 2 - (s.left + s.width / 2);
    if (Math.abs(delta) > 1) {
      scroller.scrollBy({ left: delta, behavior: "smooth" });
    }
  };

  const runCenter = () => {
    const match = findActiveTarget();
    if (match) centerTarget(match.target, match.scroller);
  };

  const scheduleCenter = (delay = 24) => {
    if (rafId) cancelAnimationFrame(rafId);
    if (timerId) clearTimeout(timerId);
    rafId = requestAnimationFrame(() => {
      timerId = setTimeout(runCenter, delay);
    });
  };

  document.addEventListener(
    "click",
    (e) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el) return;
      const button = el.closest('button,[role="button"]');
      if (!button) return;
      const label = (
        button.getAttribute("aria-label") ||
        button.textContent ||
        ""
      ).toLowerCase();
      if (
        label.includes("next") ||
        label.includes("previous") ||
        label.includes("prev") ||
        label.includes("image") ||
        button.closest('[role="dialog"],[aria-modal="true"]')
      ) {
        scheduleCenter(28);
      }
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        scheduleCenter(28);
      }
    },
    true,
  );

  document.addEventListener(
    "focusin",
    () => {
      scheduleCenter(28);
    },
    true,
  );

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") {
        scheduleCenter(20);
        return;
      }
      if (m.type === "childList" && m.addedNodes.length > 0) {
        scheduleCenter(20);
        return;
      }
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: OBSERVED_ATTRS,
  });

  scheduleCenter(80);
});
