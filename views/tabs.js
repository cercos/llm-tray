let tabs = [];
let activeTabId = null;
let openFloatingMenu = null;
let cleanupFloatingMenu = null;
let floatingMenuOpenedAt = 0;
let floatingMenuReturnFocusEl = null;
const closedTabHistory = [];
const CLOSED_TAB_HISTORY_LIMIT = 30;
const FALLBACK_LLMS = {
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/",
  claude: "https://claude.ai/",
  grok: "https://grok.com/",
};
const LLM_BRANDS = {
  chatgpt: {
    accent: "#10a37f",
    bg: "rgba(16, 163, 127, 0.16)",
    bgHover: "rgba(16, 163, 127, 0.24)",
    border: "rgba(16, 163, 127, 0.5)",
    icon: "https://chatgpt.com/favicon.ico",
  },
  gemini: {
    accent: "#4f8dfc",
    bg: "rgba(79, 141, 252, 0.16)",
    bgHover: "rgba(79, 141, 252, 0.24)",
    border: "rgba(79, 141, 252, 0.52)",
    icon: "https://gemini.google.com/favicon.ico",
  },
  claude: {
    accent: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.16)",
    bgHover: "rgba(245, 158, 11, 0.25)",
    border: "rgba(245, 158, 11, 0.5)",
    icon: "https://claude.ai/favicon.ico",
  },
  grok: {
    accent: "#9ecbff",
    bg: "rgba(158, 203, 255, 0.14)",
    bgHover: "rgba(158, 203, 255, 0.22)",
    border: "rgba(158, 203, 255, 0.45)",
    icon: "https://grok.com/favicon.ico",
  },
};
let availableLLMs = { ...FALLBACK_LLMS };
let downloads = [];
let downloadsPanel = null;
let cleanupDownloadsPanel = null;
let downloadsPanelOpenedAt = 0;
let downloadPollTimer = null;

const tabbar = document.getElementById("tabbar");
const container = document.getElementById("container");
const api = window.electronAPI || {};
const webviewPreloadURL = new URL("./preload-webview.js", window.location.href).toString();
let chromelessMode = false;
let cleanupWindowStateListener = null;
let cleanupTabTransferListener = null;
let currentWindowId = null;
let activeTabDrag = null;
let tabDragSessionClearTimer = 0;
const TAB_DRAG_MIME = "application/x-llmtray-tab";
const TAB_DRAG_DETACH_DISTANCE = 24;
const TAB_DRAG_FOLLOW_WINDOW = false;
const TAB_DRAG_WINDOW_OPACITY = 0.86;
const TAB_DRAG_WINDOW_OFFSET_X = 18;
const TAB_DRAG_WINDOW_OFFSET_Y = 24;
const TAB_DRAG_DETACH_SETTLE_DELAY_MS = 140;
const TAB_DRAG_SESSION_CLEAR_DELAY_MS = 1600;
const MAX_PROMPT_TEXT_CHARS = 4000;
const DEFAULT_TAB_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='9.5' fill='none' stroke='%23dbe2ff' stroke-width='2'/%3E%3Cpath d='M6.5 16h19M16 6.5c2.8 2.3 4.5 5.8 4.5 9.5S18.8 23.2 16 25.5M16 6.5c-2.8 2.3-4.5 5.8-4.5 9.5S13.2 23.2 16 25.5' fill='none' stroke='%23dbe2ff' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E";

function sanitizePromptText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_PROMPT_TEXT_CHARS);
}

function isSafeHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function buildPromptSeedScript(promptText) {
  const serializedPrompt = JSON.stringify(promptText);
  return `
    (() => {
      const promptText = ${serializedPrompt};
      if (typeof promptText !== "string" || !promptText.trim()) return false;

      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 6 || rect.height < 6) return false;
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      };

      const isEditable = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
        if (el instanceof HTMLInputElement) {
          const type = (el.type || "text").toLowerCase();
          return (
            (type === "text" || type === "search" || type === "url") &&
            !el.disabled &&
            !el.readOnly
          );
        }
        if (el.isContentEditable) return true;
        return (el.getAttribute("role") || "").toLowerCase() === "textbox";
      };

      const selectors = [
        "textarea",
        "input[type=\\"text\\"]",
        "input[type=\\"search\\"]",
        "input[type=\\"url\\"]",
        "[contenteditable=\\"\\"]",
        "[contenteditable=\\"true\\"]",
        "[role=\\"textbox\\"]",
      ];

      const candidates = [];
      if (document.activeElement instanceof HTMLElement) {
        candidates.push(document.activeElement);
      }
      for (const el of document.querySelectorAll(selectors.join(","))) {
        candidates.push(el);
      }

      const seen = new Set();
      const target = candidates.find((el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (seen.has(el)) return false;
        seen.add(el);
        return isEditable(el) && isVisible(el);
      });
      if (!target) return false;

      try {
        target.focus();
      } catch {}

      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        target.value = promptText;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      try {
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } catch {}

      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, promptText);
      } catch {}

      if (!inserted) target.textContent = promptText;

      try {
        target.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: false,
            inputType: "insertText",
            data: promptText,
          }),
        );
      } catch {
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return true;
    })();
  `;
}

function seedPromptInWebview(webview, promptText) {
  const safePrompt = sanitizePromptText(promptText);
  if (!safePrompt || !webview) return;
  const script = buildPromptSeedScript(safePrompt);
  let seeded = false;
  let inFlight = false;
  const runSeed = () => {
    if (seeded || inFlight) return;
    inFlight = true;
    webview
      .executeJavaScript(script, true)
      .then((result) => {
        if (result === true) seeded = true;
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };
  runSeed();
  setTimeout(runSeed, 450);
  setTimeout(runSeed, 1400);
  setTimeout(runSeed, 2600);
}

function normalizeUrlForMatch(url) {
  if (!url || typeof url !== "string") return "";
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

function inferLLMKeyFromURL(url, fallbackKey) {
  if (url && typeof url === "string") {
    const lowerUrl = normalizeUrlForMatch(url);
    for (const [name, llmUrl] of Object.entries(availableLLMs)) {
      const llmBase = normalizeUrlForMatch(llmUrl);
      if (llmBase && (lowerUrl === llmBase || lowerUrl.startsWith(`${llmBase}/`))) {
        return name;
      }
    }
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("chatgpt.com") || host.includes("openai.com")) return "chatgpt";
    if (host.includes("gemini.google.com")) return "gemini";
    if (host.includes("claude.ai")) return "claude";
    if (host.includes("grok.com") || host.includes("x.ai")) return "grok";
    return host.replace(/^www\./, "");
  } catch {
    return fallbackKey && typeof fallbackKey === "string" ? fallbackKey : "chatgpt";
  }
}

function getTabView(tab) {
  return tab.webview || tab.picker || null;
}

function setTabButtonLabel(id, label) {
  const btn = tabbar.querySelector(`.tab[data-id="${id}"] .tab-label`);
  if (!btn) return;
  const resolved = typeof label === "string" ? label : "";
  btn.textContent = resolved;
  btn.title = resolved;
}

function normalizeTabTitle(title) {
  if (typeof title !== "string") return "";
  const compact = title.replace(/\s+/g, " ").trim();
  if (!compact || compact.toLowerCase() === "about:blank") return "";
  return compact;
}

function getTabDisplayLabel(tab, fallbackLabel = "") {
  const title = normalizeTabTitle(tab?.title);
  if (title) return title;
  if (typeof fallbackLabel === "string" && fallbackLabel.trim()) return fallbackLabel.trim();
  if (typeof tab?.llmKey === "string" && tab.llmKey.trim()) return tab.llmKey.trim();
  return "tab";
}

function getUrlHostname(url) {
  if (!url || typeof url !== "string") return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function buildFaviconCandidatesForUrl(url) {
  if (!url || typeof url !== "string") return [];
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol === "https:" ? "https:" : "http:";
    const host = parsed.hostname.toLowerCase();
    if (!host) return [];
    const candidates = [
      `${protocol}//${host}/favicon.ico`,
      `https://${host}/favicon.ico`,
      `https://www.google.com/s2/favicons?domain=${host}&sz=64`,
    ];
    if (host.startsWith("www.")) {
      const bareHost = host.slice(4);
      if (bareHost) {
        candidates.push(`${protocol}//${bareHost}/favicon.ico`, `https://${bareHost}/favicon.ico`);
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

function setImageSourceWithFallback(img, candidates) {
  if (!(img instanceof HTMLImageElement)) return;

  const dedupedCandidates = [];
  const seen = new Set();
  candidates.forEach((candidate) => {
    if (typeof candidate !== "string") return;
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    dedupedCandidates.push(trimmed);
  });
  if (!dedupedCandidates.length) dedupedCandidates.push(DEFAULT_TAB_ICON);

  const previous = img.dataset.currentFavicon || "";
  const next = dedupedCandidates[0];
  img._faviconCandidates = dedupedCandidates;
  img._faviconIndex = 0;
  if (previous === next && img.getAttribute("src")) return;
  img.dataset.currentFavicon = next;
  img.src = next;
}

function setTabButtonIcon(id, primaryIcon, pageUrl, llmKey) {
  const iconEl = tabbar.querySelector(`.tab[data-id="${id}"] .tab-favicon`);
  if (!(iconEl instanceof HTMLImageElement)) return;

  const themeIcon = getThemeForLLM(llmKey, pageUrl).icon;
  const urlFallbacks = buildFaviconCandidatesForUrl(pageUrl);
  setImageSourceWithFallback(iconEl, [primaryIcon, themeIcon, ...urlFallbacks, DEFAULT_TAB_ICON]);
}

function getTabRecord(id) {
  return tabs.find((t) => t.id === id) || null;
}

function getCurrentTabURL(tab) {
  if (!tab) return null;
  if (tab.webview) {
    try {
      return tab.webview.getURL() || tab.url || null;
    } catch {
      return tab.url || null;
    }
  }
  return tab.url || null;
}

function snapshotTabForHistory(tab) {
  if (!tab) return null;
  if (tab.picker && !tab.webview) return { kind: "picker" };

  const url = getCurrentTabURL(tab);
  if (!url) return null;
  return {
    kind: "webview",
    llmKey: tab.llmKey || inferLLMKeyFromURL(url, "chatgpt"),
    url,
  };
}

function rememberClosedTab(tab) {
  const snapshot = snapshotTabForHistory(tab);
  if (!snapshot) return;
  closedTabHistory.push(snapshot);
  if (closedTabHistory.length > CLOSED_TAB_HISTORY_LIMIT) {
    closedTabHistory.splice(0, closedTabHistory.length - CLOSED_TAB_HISTORY_LIMIT);
  }
}

function reopenClosedTab() {
  const snapshot = closedTabHistory.pop();
  if (!snapshot) return;
  if (snapshot.kind === "picker") {
    createPickerTab();
    return;
  }
  const label = inferLLMKeyFromURL(snapshot.url, snapshot.llmKey || "chatgpt");
  createTab(label, snapshot.url);
}

function canReopenClosedTab() {
  return closedTabHistory.length > 0;
}

function getTabIdsInDomOrder() {
  return [...tabbar.querySelectorAll(".tab[data-id]")]
    .map((el) => el.dataset.id)
    .filter(Boolean);
}

function closeTabsOtherThan(id) {
  const toClose = getTabIdsInDomOrder().filter((tabId) => tabId !== id);
  if (!toClose.length) return;
  toClose.forEach((tabId) => closeTab(tabId, { createPickerWhenEmpty: false }));
  if (tabs.some((tab) => tab.id === id)) activateTab(id);
}

function closeTabsToRight(id) {
  const ordered = getTabIdsInDomOrder();
  const index = ordered.indexOf(id);
  if (index < 0) return;
  const toClose = ordered.slice(index + 1);
  if (!toClose.length) return;
  toClose.forEach((tabId) => closeTab(tabId, { createPickerWhenEmpty: false }));
  if (tabs.some((tab) => tab.id === id)) activateTab(id);
}

function fallbackCopyText(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}

function copyTextToClipboard(text) {
  if (typeof text !== "string" || !text) return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text).catch(() => {
      fallbackCopyText(text);
    });
    return true;
  }
  return fallbackCopyText(text);
}

function copyTabURL(id) {
  const url = getCurrentTabURL(getTabRecord(id));
  if (!url) return;
  copyTextToClipboard(url);
}

function syncTabOrderFromDOM() {
  const orderedIds = getTabIdsInDomOrder();
  if (!orderedIds.length) return;
  const pos = new Map(orderedIds.map((id, idx) => [id, idx]));
  tabs.sort((a, b) => (pos.get(a.id) ?? 99999) - (pos.get(b.id) ?? 99999));
}

function placeTabButtonAtClientX(tabId, clientX) {
  const tabEl = tabbar.querySelector(`.tab[data-id="${tabId}"]`);
  if (!tabEl) return;

  const peers = [...tabbar.querySelectorAll(".tab[data-id]")].filter((el) => el !== tabEl);
  let beforeEl = null;
  for (const el of peers) {
    const rect = el.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      beforeEl = el;
      break;
    }
  }

  const addBtn = document.getElementById("addTab");
  if (beforeEl) tabbar.insertBefore(tabEl, beforeEl);
  else if (addBtn) tabbar.insertBefore(tabEl, addBtn);
  else tabbar.appendChild(tabEl);
}

function buildDraggedTabPayload(tabId) {
  const tab = getTabRecord(tabId);
  if (!tab) return null;
  if (tab.picker) {
    return {
      sourceWindowId: currentWindowId,
      sourceTabId: tabId,
      llmKey: tab.llmKey || "new tab",
      kind: "picker",
      url: null,
    };
  }
  const url = getCurrentTabURL(tab);
  if (!url) return null;
  return {
    sourceWindowId: currentWindowId,
    sourceTabId: tabId,
    llmKey: tab.llmKey,
    kind: "webview",
    url,
  };
}

function readDraggedTabPayload(dataTransfer) {
  if (!dataTransfer) return null;
  let raw = "";
  try {
    raw = dataTransfer.getData(TAB_DRAG_MIME);
  } catch {
    raw = "";
  }
  if (!raw) {
    try {
      raw = dataTransfer.getData("application/x-llmtray-tab+json");
    } catch {
      raw = "";
    }
  }
  if (!raw) {
    try {
      const text = dataTransfer.getData("text/plain");
      if (typeof text === "string" && text.startsWith("llmtray-tab:")) {
        raw = text.slice("llmtray-tab:".length);
      }
    } catch {
      raw = "";
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.sourceTabId !== "string" || !parsed.sourceTabId) return null;
    const sourceWindowId = Number(parsed.sourceWindowId);
    if (!Number.isInteger(sourceWindowId) || sourceWindowId < 1) return null;
    const kind = parsed.kind === "picker" ? "picker" : "webview";
    const url = kind === "webview" && typeof parsed.url === "string" ? parsed.url : null;
    if (kind === "webview" && !url) return null;
    const llmKey =
      typeof parsed.llmKey === "string" && parsed.llmKey.trim()
        ? parsed.llmKey.trim()
        : inferLLMKeyFromURL(url || FALLBACK_LLMS.chatgpt, "chatgpt");
    return {
      sourceWindowId,
      sourceTabId: parsed.sourceTabId,
      llmKey,
      kind,
      url,
    };
  } catch {
    return null;
  }
}

function hasPotentialTabPayload(dataTransfer) {
  if (!dataTransfer) return false;
  let types = [];
  try {
    types = Array.from(dataTransfer.types || []);
  } catch {
    types = [];
  }
  if (types.includes(TAB_DRAG_MIME) || types.includes("application/x-llmtray-tab+json")) {
    return true;
  }
  if (!types.includes("text/plain")) return false;
  try {
    const text = dataTransfer.getData("text/plain");
    if (!text) return true;
    return text.startsWith("llmtray-tab:");
  } catch {
    return true;
  }
}

function setWindowDragOpacity(opacity) {
  if (typeof api.setWindowOpacity !== "function") return;
  api.setWindowOpacity(opacity).catch(() => {});
}

function getRendererWindowPosition() {
  const x = Number(window.screenX);
  const y = Number(window.screenY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function normalizeDragScreenPoint(screenX, screenY, dragState) {
  const x = Number(screenX);
  const y = Number(screenY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const startedAtOrigin =
    Number(dragState?.startScreenX) === 0 && Number(dragState?.startScreenY) === 0;
  if (!startedAtOrigin && x === 0 && y === 0) return null;
  return { x, y };
}

function getDragEndPoint(e, dragState) {
  const direct = normalizeDragScreenPoint(e?.screenX, e?.screenY, dragState);
  if (direct) return direct;
  const last = normalizeDragScreenPoint(dragState?.lastScreenX, dragState?.lastScreenY, dragState);
  if (last) return last;
  return {
    x: Number(dragState?.startScreenX) || 0,
    y: Number(dragState?.startScreenY) || 0,
  };
}

async function primeWindowFollowForDrag(dragState) {
  if (!dragState || dragState.windowFollowPrimed) return;
  dragState.windowFollowPrimed = true;

  if (typeof api.setWindowPosition !== "function") {
    return;
  }

  const rendererPos = getRendererWindowPosition();
  if (rendererPos) {
    dragState.windowStartX = rendererPos.x;
    dragState.windowStartY = rendererPos.y;
    dragState.windowFollowEnabled = true;
    return;
  }

  if (typeof api.getWindowBounds !== "function") return;

  try {
    const bounds = await api.getWindowBounds();
    if (!bounds) return;
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    dragState.windowStartX = x;
    dragState.windowStartY = y;
    dragState.windowFollowEnabled = true;
  } catch {}
}

function scheduleWindowFollowMove(dragState, screenX, screenY) {
  if (!dragState || !dragState.windowFollowEnabled) return;
  dragState.lastScreenX = screenX;
  dragState.lastScreenY = screenY;
  if (dragState.windowMoveRaf) return;

  dragState.windowMoveRaf = requestAnimationFrame(() => {
    dragState.windowMoveRaf = 0;
    if (!dragState.windowFollowEnabled) return;

    const deltaX = dragState.lastScreenX - dragState.startScreenX;
    const deltaY = dragState.lastScreenY - dragState.startScreenY;
    // Remove the offsets - just move the window directly with the cursor
    const nextX = Math.round(dragState.windowStartX + deltaX);
    const nextY = Math.round(dragState.windowStartY + deltaY);
    if (nextX === dragState.windowLastX && nextY === dragState.windowLastY) return;

    dragState.windowLastX = nextX;
    dragState.windowLastY = nextY;
    api.setWindowPosition({ x: nextX, y: nextY }).catch(() => {});
  });
}

function handleTabDragStart(e, tabId) {
  if (tabDragSessionClearTimer) {
    clearTimeout(tabDragSessionClearTimer);
    tabDragSessionClearTimer = 0;
  }

  const payload = buildDraggedTabPayload(tabId);
  if (!payload || !payload.sourceWindowId) {
    e.preventDefault();
    return;
  }

  activeTabDrag = {
    tabId,
    startScreenX: e.screenX || 0,
    startScreenY: e.screenY || 0,
    singleTabAtStart: tabs.length === 1,
    droppedInsideWindow: false,
    windowFollowPrimed: false,
    windowFollowEnabled: false,
    windowStartX: 0,
    windowStartY: 0,
    windowLastX: null,
    windowLastY: null,
    lastScreenX: e.screenX || 0,
    lastScreenY: e.screenY || 0,
    windowMoveRaf: 0,
  };

  if (TAB_DRAG_FOLLOW_WINDOW) {
    setWindowDragOpacity(TAB_DRAG_WINDOW_OPACITY);
    primeWindowFollowForDrag(activeTabDrag);
  }

  const tabEl = tabbar.querySelector(`.tab[data-id="${tabId}"]`);
  if (tabEl) tabEl.classList.add("dragging");

  if (!e.dataTransfer) return;
  const serializedPayload = JSON.stringify(payload);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData(TAB_DRAG_MIME, serializedPayload);
  e.dataTransfer.setData("application/x-llmtray-tab+json", serializedPayload);
  e.dataTransfer.setData("text/plain", `llmtray-tab:${serializedPayload}`);
  if (payload.url) e.dataTransfer.setData("text/uri-list", payload.url);
  if (typeof api.beginTabDragSession === "function") {
    api.beginTabDragSession(payload).catch(() => {});
  }
}

function handleTabDrag(e, tabId) {
  const dragState = activeTabDrag && activeTabDrag.tabId === tabId ? activeTabDrag : null;
  if (!dragState) return;

  const point = normalizeDragScreenPoint(e.screenX, e.screenY, dragState);
  if (!point) return;

  dragState.lastScreenX = point.x;
  dragState.lastScreenY = point.y;

  if (!TAB_DRAG_FOLLOW_WINDOW) return;

  // Don't wait for window to prime - just try to move it if enabled
  if (dragState.windowFollowEnabled) {
    scheduleWindowFollowMove(dragState, point.x, point.y);
  } else if (!dragState.windowFollowPrimed) {
    // Try to prime it if it hasn't been primed yet
    primeWindowFollowForDrag(dragState);
  }
}

async function handleTabDragEnd(e, tabId) {
  const tabEl = tabbar.querySelector(`.tab[data-id="${tabId}"]`);
  if (tabEl) tabEl.classList.remove("dragging");

  const dragState = activeTabDrag && activeTabDrag.tabId === tabId ? activeTabDrag : null;
  if (dragState?.windowMoveRaf) {
    cancelAnimationFrame(dragState.windowMoveRaf);
    dragState.windowMoveRaf = 0;
  }
  if (TAB_DRAG_FOLLOW_WINDOW) {
    setWindowDragOpacity(1);
  }
  tabbar.classList.remove("drop-target");
  activeTabDrag = null;
  syncTabOrderFromDOM();
  const dragSessionKey = { sourceWindowId: currentWindowId, sourceTabId: tabId };
  if (typeof api.clearTabDragSession === "function") {
    tabDragSessionClearTimer = setTimeout(() => {
      tabDragSessionClearTimer = 0;
      api.clearTabDragSession(dragSessionKey).catch(() => {});
    }, TAB_DRAG_SESSION_CLEAR_DELAY_MS);
  }
  if (!dragState) return;

  if (dragState.droppedInsideWindow) return;

  await new Promise((resolve) => setTimeout(resolve, TAB_DRAG_DETACH_SETTLE_DELAY_MS));
  if (!tabs.some((t) => t.id === tabId)) return;

  const endPoint = getDragEndPoint(e, dragState);
  const distance = Math.hypot(
    endPoint.x - dragState.startScreenX,
    endPoint.y - dragState.startScreenY,
  );

  // Tear a tab out into a new tab-host window when dropped outside.
  if (distance < TAB_DRAG_DETACH_DISTANCE) return;
  if (dragState.singleTabAtStart) return;
  const payload = buildDraggedTabPayload(tabId);
  if (payload?.kind !== "webview") return;
  if (!payload || typeof api.openNewTabWindow !== "function") return;
  const detachedWindowX = Math.round(endPoint.x - TAB_DRAG_WINDOW_OFFSET_X);
  const detachedWindowY = Math.round(endPoint.y - TAB_DRAG_WINDOW_OFFSET_Y);
  try {
    const opened = await api.openNewTabWindow({
      url: payload.url,
      llmKey: payload.llmKey,
      x: detachedWindowX,
      y: detachedWindowY,
    });
    if (!opened) return;
    closeTab(tabId, { trackHistory: false });
  } catch {}
}

function openAddMenuNearButton() {
  const addBtn = document.getElementById("addTab");
  if (!addBtn) {
    showAddMenu(availableLLMs, 10, 36, tabbar);
    return;
  }
  const rect = addBtn.getBoundingClientRect();
  showAddMenu(availableLLMs, Math.round(rect.left), Math.round(rect.bottom + 4), addBtn);
}

function syncTabFromURL(id, url) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || !url) return;
  const previousHost = getUrlHostname(tab.url);
  const nextHost = getUrlHostname(url);
  tab.url = url;
  if (previousHost !== nextHost) {
    tab.title = "";
    tab.icon = "";
  }
  const key = inferLLMKeyFromURL(url, tab.llmKey);
  tab.llmKey = key;
  setTabButtonLabel(id, getTabDisplayLabel(tab, key));
  setTabButtonIcon(id, tab.icon, url, key);
}

function syncTabFaviconFromWebview(id, faviconUrl) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  tab.icon = typeof faviconUrl === "string" ? faviconUrl.trim() : "";
  const url = getCurrentTabURL(tab);
  setTabButtonIcon(id, tab.icon, url || tab.url, tab.llmKey);
}

function syncTabTitleFromWebview(id, pageTitle) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  tab.title = normalizeTabTitle(pageTitle);
  setTabButtonLabel(id, getTabDisplayLabel(tab, tab.llmKey));
}

function getCustomTheme(key, url) {
  const label = key || "llm";
  const hash = [...label].reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = hash % 360;
  let icon = "";
  try {
    const parsed = new URL(url);
    icon = `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=64`;
  } catch {}
  return {
    accent: `hsl(${hue}, 78%, 68%)`,
    bg: `hsla(${hue}, 78%, 68%, 0.16)`,
    bgHover: `hsla(${hue}, 78%, 68%, 0.24)`,
    border: `hsla(${hue}, 78%, 68%, 0.5)`,
    icon,
  };
}

function getThemeForLLM(key, url) {
  const lower = (key || "").toLowerCase();
  return LLM_BRANDS[lower] || getCustomTheme(lower || key, url);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const precision = value >= 100 || idx === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[idx]}`;
}

function truncateText(text, max = 42) {
  if (!text || text.length <= max) return text || "";
  return `${text.slice(0, max - 1)}…`;
}

function isActiveDownload(rec) {
  return ["starting", "downloading", "paused", "interrupted"].includes(rec?.state);
}

function getDownloadsButton() {
  return document.getElementById("downloadsBtn");
}

function getDownloadsBadge() {
  return document.getElementById("downloadsBadge");
}

function setChromelessMode(enabled) {
  chromelessMode = !!enabled;
  document.body.classList.toggle("chromeless", chromelessMode);
  ensureTabbarControls();
}

function setMaximizeButtonState(isMaximized) {
  const btn = document.getElementById("winMaximize");
  if (!btn) return;
  const maximized = !!isMaximized;
  btn.classList.toggle("is-maximized", maximized);
  btn.title = maximized ? "Restore" : "Maximize";
  btn.setAttribute("aria-label", btn.title);
}

async function refreshWindowState() {
  if (typeof api.getWindowMaximized !== "function") return;
  try {
    const maximized = await api.getWindowMaximized();
    setMaximizeButtonState(maximized);
  } catch {}
}

function ensureWindowControls() {
  const existing = document.getElementById("windowControls");

  if (!chromelessMode) {
    if (existing) existing.remove();
    if (cleanupWindowStateListener) {
      cleanupWindowStateListener();
      cleanupWindowStateListener = null;
    }
    return;
  }

  if (existing) return;

  const controls = document.createElement("div");
  controls.id = "windowControls";
  controls.innerHTML = `
    <button class="window-control minimize" id="winMinimize" type="button" title="Minimize" aria-label="Minimize"><span class="wc-icon"></span></button>
    <button class="window-control maximize" id="winMaximize" type="button" title="Maximize" aria-label="Maximize"><span class="wc-icon"></span></button>
    <button class="window-control close" id="winClose" type="button" title="Close" aria-label="Close"><span class="wc-icon"></span></button>
  `;
  tabbar.appendChild(controls);

  const minimizeBtn = controls.querySelector("#winMinimize");
  const maximizeBtn = controls.querySelector("#winMaximize");
  const closeBtn = controls.querySelector("#winClose");

  if (minimizeBtn) {
    minimizeBtn.addEventListener("click", async () => {
      if (typeof api.windowMinimize === "function") await api.windowMinimize();
    });
  }
  if (maximizeBtn) {
    maximizeBtn.addEventListener("click", async () => {
      if (typeof api.windowToggleMaximize === "function") {
        await api.windowToggleMaximize();
      }
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", async () => {
      if (typeof api.windowClose === "function") await api.windowClose();
    });
  }

  if (typeof api.onWindowMaximized === "function") {
    cleanupWindowStateListener = api.onWindowMaximized((isMaximized) => {
      setMaximizeButtonState(isMaximized);
    });
  }
  refreshWindowState();
}

function closeDownloadsPanel() {
  if (cleanupDownloadsPanel) {
    cleanupDownloadsPanel();
    cleanupDownloadsPanel = null;
  }
  if (downloadsPanel && downloadsPanel.isConnected) downloadsPanel.remove();
  downloadsPanel = null;
  downloadsPanelOpenedAt = 0;
  const btn = getDownloadsButton();
  if (btn) btn.classList.remove("active");
}

function renderDownloadsBadge() {
  const badge = getDownloadsBadge();
  if (!badge) return;
  const activeCount = downloads.filter((d) => isActiveDownload(d)).length;
  if (activeCount <= 0) {
    badge.style.display = "none";
    badge.textContent = "";
    return;
  }
  badge.style.display = "inline-block";
  badge.textContent = activeCount > 99 ? "99+" : String(activeCount);
}

async function refreshDownloads() {
  if (typeof api.getDownloadTracker !== "function") return;
  try {
    const next = await api.getDownloadTracker();
    downloads = Array.isArray(next) ? next : [];
    renderDownloadsBadge();
    if (downloadsPanel && downloadsPanel.isConnected) {
      renderDownloadsPanel();
    }
  } catch {}
}

function startDownloadPolling() {
  if (downloadPollTimer) return;
  refreshDownloads();
  downloadPollTimer = setInterval(refreshDownloads, 1000);
}

async function openDownloadItem(id) {
  if (typeof api.openDownloadItem !== "function") return;
  await api.openDownloadItem(id);
  await refreshDownloads();
}

async function cancelDownloadItem(id) {
  if (typeof api.cancelDownloadItem !== "function") return;
  await api.cancelDownloadItem(id);
  await refreshDownloads();
}

async function clearFinishedDownloadsFromPanel() {
  if (typeof api.clearFinishedDownloads !== "function") return;
  await api.clearFinishedDownloads();
  await refreshDownloads();
}

function renderDownloadsPanel() {
  if (!downloadsPanel) return;

  const hasClearable = downloads.some((d) => !isActiveDownload(d));
  const header = `
    <div class="downloads-panel-header">
      <div class="downloads-panel-title">Downloads</div>
      <div class="downloads-panel-actions">
        <button class="downloads-mini-btn" id="downloadsOpenFolderBtn">Folder</button>
        <button class="downloads-mini-btn" id="downloadsClearBtn" ${hasClearable ? "" : "disabled"}>Clear</button>
      </div>
    </div>
  `;

  const rows = downloads
    .slice(0, 20)
    .map((rec) => {
      const total = Number(rec.totalBytes || 0);
      const received = Number(rec.receivedBytes || 0);
      const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
      const statusText = isActiveDownload(rec)
        ? total > 0
          ? `${pct}% - ${formatBytes(received)} of ${formatBytes(total)}`
          : `${rec.state} - ${formatBytes(received)}`
        : rec.state === "completed"
          ? "Done"
          : rec.state === "failed"
            ? "Failed"
            : rec.state === "cancelled"
              ? "Cancelled"
              : rec.state === "interrupted"
                ? "Interrupted"
                : rec.state || "Unknown";

      const action =
        rec.state === "completed"
          ? `<button class="downloads-mini-btn" data-open-id="${rec.id}">Show</button>`
          : isActiveDownload(rec)
            ? `<button class="downloads-mini-btn" data-cancel-id="${rec.id}">Cancel</button>`
            : "";

      return `
        <div class="download-item">
          <div class="download-item-top">
            <div class="download-name" title="${(rec.filename || "").replace(/"/g, "&quot;")}">${truncateText(rec.filename || "download")}</div>
            <div class="download-status">${statusText}</div>
          </div>
          <div class="download-progress">
            <div class="download-progress-fill" style="width:${rec.state === "completed" ? 100 : pct}%"></div>
          </div>
          <div class="download-item-actions">${action}</div>
        </div>
      `;
    })
    .join("");

  downloadsPanel.innerHTML = `
    ${header}
    <div class="downloads-list">
      ${rows || '<div class="downloads-empty">No downloads yet.</div>'}
    </div>
  `;

  const openFolder = downloadsPanel.querySelector("#downloadsOpenFolderBtn");
  if (openFolder) {
    openFolder.onclick = async () => {
      if (typeof api.openDownloadsFolder === "function") {
        await api.openDownloadsFolder();
      }
    };
  }

  const clearBtn = downloadsPanel.querySelector("#downloadsClearBtn");
  if (clearBtn) clearBtn.onclick = () => clearFinishedDownloadsFromPanel();

  downloadsPanel.querySelectorAll("[data-open-id]").forEach((btn) => {
    btn.addEventListener("click", () => openDownloadItem(btn.dataset.openId));
  });
  downloadsPanel.querySelectorAll("[data-cancel-id]").forEach((btn) => {
    btn.addEventListener("click", () => cancelDownloadItem(btn.dataset.cancelId));
  });
}

function toggleDownloadsPanel() {
  if (downloadsPanel && downloadsPanel.isConnected) {
    closeDownloadsPanel();
    return;
  }

  closeFloatingMenu();
  const btn = getDownloadsButton();
  if (!btn) return;

  downloadsPanel = document.createElement("div");
  downloadsPanel.className = "downloads-panel";
  document.body.appendChild(downloadsPanel);
  btn.classList.add("active");
  downloadsPanelOpenedAt = Date.now();
  renderDownloadsPanel();

  const onPointerDownCapture = (e) => {
    if (downloadsPanel?.contains(e.target) || btn.contains(e.target)) return;
    closeDownloadsPanel();
  };
  const onKeyDown = (e) => {
    if (e.key === "Escape") closeDownloadsPanel();
  };

  document.addEventListener("pointerdown", onPointerDownCapture, true);
  document.addEventListener("keydown", onKeyDown, true);
  cleanupDownloadsPanel = () => {
    document.removeEventListener("pointerdown", onPointerDownCapture, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}

function createManagedWebview(url, onNavigated, options = {}) {
  let pendingPromptText = sanitizePromptText(options.promptText);
  const onFavicon = typeof options.onFavicon === "function" ? options.onFavicon : null;
  const onTitle = typeof options.onTitle === "function" ? options.onTitle : null;
  const webview = document.createElement("webview");
  webview.setAttribute("preload", webviewPreloadURL);
  webview.setAttribute("allowpopups", "true");
  webview.setAttribute("spellcheck", "true");
  webview.setAttribute(
    "webpreferences",
    "nativeWindowOpen=yes, scrollBounce=yes, contextIsolation=true, backgroundThrottling=false, offscreen=false",
  );

  webview.addEventListener("new-window", (e) => {
    e.preventDefault();
    if (typeof api.openExternal === "function") api.openExternal(e.url);
  });

  webview.addEventListener("will-navigate", (e) => {
    try {
      const current = new URL(webview.getURL()).origin;
      const next = new URL(e.url).origin;
      if (current === next) return;
    } catch {}
    e.preventDefault();
    if (typeof api.openExternal === "function") api.openExternal(e.url);
  });

  webview.addEventListener("ipc-message", (e) => {
    if (e.channel === "guest-new-tab") {
      createPickerTab();
      return;
    }
    if (e.channel === "guest-open-devtools") {
      webview.openDevTools();
      return;
    }
    if (e.channel !== "guest-pointerdown" && e.channel !== "guest-contextmenu") {
      return;
    }
    const eventTime = Number(e.args?.[0] || 0);
    if (!eventTime || eventTime >= floatingMenuOpenedAt) {
      closeFloatingMenu();
    }
    if (!eventTime || eventTime >= downloadsPanelOpenedAt) {
      closeDownloadsPanel();
    }
  });

  webview.addEventListener("dom-ready", () => {
    nudgeWebviewResize(webview);
    if (onTitle) {
      try {
        onTitle(webview.getTitle() || "");
      } catch {}
    }
    if (pendingPromptText) {
      seedPromptInWebview(webview, pendingPromptText);
      pendingPromptText = null;
    }
  });
  webview.addEventListener("did-navigate", (e) => {
    if (typeof onNavigated === "function") onNavigated(e.url);
  });
  webview.addEventListener("did-navigate-in-page", (e) => {
    if (typeof onNavigated === "function") onNavigated(e.url);
  });
  webview.addEventListener("page-favicon-updated", (e) => {
    if (!onFavicon) return;
    const nextIcon = Array.isArray(e.favicons)
      ? e.favicons.find((candidate) => typeof candidate === "string" && candidate.trim())
      : "";
    onFavicon(nextIcon || "");
  });
  webview.addEventListener("page-title-updated", (e) => {
    if (!onTitle) return;
    onTitle(e.title || "");
  });
  webview.src = url;
  webview.classList.add("tab-view");
  webview.style.visibility = "hidden";
  webview.style.pointerEvents = "none";
  return webview;
}

// -----------------------------------------------------
// CREATE TAB
// -----------------------------------------------------
function createTab(llmKey, url, options = {}) {
  const id = `tab-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const webview = createManagedWebview(
    url,
    (nextUrl) => syncTabFromURL(id, nextUrl),
    {
      ...options,
      onFavicon: (nextIcon) => syncTabFaviconFromWebview(id, nextIcon),
      onTitle: (nextTitle) => syncTabTitleFromWebview(id, nextTitle),
    },
  );
  container.appendChild(webview);
  tabs.push({ id, llmKey, url, title: "", icon: "", webview, picker: null });
  createTabButton(id, llmKey, url);
  activateTab(id);
  return id;
}

function createPickerTab() {
  const id = `tab-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const picker = document.createElement("div");
  picker.className = "tab-view new-tab-picker";
  picker.style.visibility = "hidden";
  picker.style.pointerEvents = "none";
  picker.innerHTML = `
    <div class="new-tab-card">
      <h2>Open an LLM</h2>
      <div class="new-tab-grid"></div>
    </div>
  `;
  const grid = picker.querySelector(".new-tab-grid");
  const llms = Object.entries(availableLLMs);
  llms.forEach(([key, url]) => {
    const theme = getThemeForLLM(key, url);
    const btn = document.createElement("button");
    btn.className = "new-tab-btn";
    btn.style.setProperty("--llm-accent", theme.accent);
    btn.style.setProperty("--llm-bg", theme.bg);
    btn.style.setProperty("--llm-bg-hover", theme.bgHover);
    btn.style.setProperty("--llm-border", theme.border);
    btn.innerHTML = `
      <img class="new-tab-btn-icon" alt="" />
      <span class="new-tab-btn-label">${key}</span>
    `;
    const icon = btn.querySelector(".new-tab-btn-icon");
    if (icon && theme.icon) {
      icon.src = theme.icon;
      icon.onerror = () => {
        icon.style.display = "none";
      };
    } else if (icon) {
      icon.style.display = "none";
    }
    btn.addEventListener("click", () => loadLLMInTab(id, key, url));
    grid.appendChild(btn);
  });
  container.appendChild(picker);
  tabs.push({ id, llmKey: "new tab", url: null, title: "", icon: "", webview: null, picker });
  createTabButton(id, "new tab", null);
  activateTab(id);
  return id;
}

function loadLLMInTab(id, llmKey, url) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || !url) return;

  if (tab.picker) {
    tab.picker.remove();
    tab.picker = null;
  }

  tab.llmKey = llmKey;
  tab.url = url;
  tab.title = "";
  tab.icon = "";
  tab.webview = createManagedWebview(
    url,
    (nextUrl) => syncTabFromURL(id, nextUrl),
    {
      onFavicon: (nextIcon) => syncTabFaviconFromWebview(id, nextIcon),
      onTitle: (nextTitle) => syncTabTitleFromWebview(id, nextTitle),
    },
  );
  container.appendChild(tab.webview);
  setTabButtonLabel(id, getTabDisplayLabel(tab, llmKey));
  setTabButtonIcon(id, "", url, llmKey);
  activateTab(id);
}

// -----------------------------------------------------
// TAB BUTTON UI
// -----------------------------------------------------
function createTabButton(id, llmKey, url = null) {
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.dataset.id = id;
  tab.style.webkitUserDrag = "element";
  tab.draggable = true;
  tab.innerHTML = `
    <img class="tab-favicon" alt="" draggable="false" />
    <span class="tab-label"></span>
    <button class="close" type="button" aria-label="Close tab">×</button>
  `;
  const labelEl = tab.querySelector(".tab-label");
  if (labelEl) labelEl.textContent = llmKey;
  const iconEl = tab.querySelector(".tab-favicon");
  if (iconEl) {
    iconEl.addEventListener("error", () => {
      const candidates = Array.isArray(iconEl._faviconCandidates) ? iconEl._faviconCandidates : [];
      const currentIndex = Number.isFinite(iconEl._faviconIndex) ? iconEl._faviconIndex : 0;
      const nextIndex = currentIndex + 1;
      if (nextIndex >= candidates.length) return;
      iconEl._faviconIndex = nextIndex;
      const nextSource = candidates[nextIndex];
      iconEl.dataset.currentFavicon = nextSource;
      iconEl.src = nextSource;
    });
  }

  tab.addEventListener("click", () => activateTab(id));
  tab.addEventListener("dragstart", (e) => handleTabDragStart(e, id));
  tab.addEventListener("drag", (e) => handleTabDrag(e, id));
  tab.addEventListener("dragend", (e) => {
    handleTabDragEnd(e, id);
  });
  tab.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const hasPointerCoords = e.clientX > 0 || e.clientY > 0;
    showTabContextMenu(id, {
      left: hasPointerCoords ? e.clientX : undefined,
      top: hasPointerCoords ? e.clientY : undefined,
      anchorEl: tab,
    });
  });
  tab.addEventListener("auxclick", (e) => {
    if (e.button === 1) closeTab(id);
  });
  tab.querySelector(".close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(id);
  });

  const addBtn = document.getElementById("addTab");
  if (addBtn) tabbar.insertBefore(tab, addBtn);
  else tabbar.appendChild(tab);
  setTabButtonIcon(id, "", url, llmKey);
}

// -----------------------------------------------------
// ACTIVATE TAB
// -----------------------------------------------------
function activateTab(id) {
  activeTabId = id;

  tabs.forEach((t) => {
    const view = getTabView(t);
    if (!view) return;
    if (t.id === id) {
      view.classList.add("active");
      view.style.visibility = "visible";
      view.style.pointerEvents = "auto";
      if (t.webview) {
        requestAnimationFrame(() => {
          t.webview.focus();
          nudgeWebviewResize(t.webview);
        });
      }
    } else {
      view.classList.remove("active");
      view.style.visibility = "hidden";
      view.style.pointerEvents = "none";
    }
  });

  [...tabbar.children].forEach((child) => {
    child.classList.toggle("active", child.dataset.id === id);
  });
}

function nudgeWebviewResize(webview) {
  if (!webview) return;
  try {
    webview.executeJavaScript(
      "window.dispatchEvent(new Event('resize')); true;",
      true,
    ).catch(() => {});
  } catch {}
}

// -----------------------------------------------------
// CLOSE TAB
// -----------------------------------------------------
function closeTab(id, options = {}) {
  const createPickerWhenEmpty = options.createPickerWhenEmpty !== false;
  const trackHistory = options.trackHistory !== false;
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const wasActive = activeTabId === id;
  const tab = tabs[idx];

  if (trackHistory) rememberClosedTab(tab);

  const view = getTabView(tab);
  if (view) view.remove();
  tabs.splice(idx, 1);

  const btn = tabbar.querySelector(`[data-id="${id}"]`);
  if (btn) btn.remove();

  if (tabs.length === 0) {
    activeTabId = null;
    if (createPickerWhenEmpty) createPickerTab();
    return;
  }

  if (wasActive) {
    activateTab(tabs[Math.max(0, idx - 1)].id);
  }
}

// -----------------------------------------------------
// DUPLICATE TAB
// -----------------------------------------------------
function duplicateTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;

  if (tab.webview) {
    createTab(tab.llmKey, tab.webview.getURL() || tab.url);
    return;
  }
  createPickerTab();
}

// -----------------------------------------------------
// RELOAD TAB
// -----------------------------------------------------
function reloadTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (tab?.webview) tab.webview.reload();
}

// -----------------------------------------------------
// OPEN TAB IN NEW WINDOW
// -----------------------------------------------------
function openTabInNewWindow(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab?.webview) return;

  const url = tab.webview.getURL() || tab.url;
  if (typeof api.openNewTabWindow === "function") {
    api.openNewTabWindow({ url, llmKey: tab.llmKey });
    return;
  }
  if (typeof api.openNewWindow === "function") {
    api.openNewWindow(url);
  }
}

// -----------------------------------------------------
// TAB CONTEXT MENU
// -----------------------------------------------------
function getEnabledFloatingMenuItems(menu) {
  return [...menu.querySelectorAll(".menu-item")].filter((el) => !el.disabled);
}

function focusFloatingMenuItem(menu, index) {
  const items = getEnabledFloatingMenuItems(menu);
  if (!items.length) {
    menu.focus();
    return;
  }
  const wrapped = ((index % items.length) + items.length) % items.length;
  items[wrapped].focus();
}

function positionFloatingMenu(
  menu,
  { left, top, anchorEl = null, minLeft = 6, minTop = 6 } = {},
) {
  let targetLeft = Number.isFinite(left) ? left : null;
  let targetTop = Number.isFinite(top) ? top : null;

  if ((targetLeft === null || targetTop === null) && anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    if (targetLeft === null) targetLeft = rect.left;
    if (targetTop === null) targetTop = rect.bottom + 4;
  }

  if (targetLeft === null) targetLeft = minLeft;
  if (targetTop === null) targetTop = minTop;

  const margin = 6;
  const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0);
  const viewportHeight = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0);
  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(minLeft, viewportWidth - rect.width - margin);
  const maxTop = Math.max(minTop, viewportHeight - rect.height - margin);

  menu.style.left = `${Math.min(maxLeft, Math.max(minLeft, Math.round(targetLeft)))}px`;
  menu.style.top = `${Math.min(maxTop, Math.max(minTop, Math.round(targetTop)))}px`;
}

function showFloatingMenu(
  items,
  { left, top, anchorEl = null, minLeft = 6, minTop = 6 } = {},
) {
  closeFloatingMenu();
  closeDownloadsPanel();

  const menu = document.createElement("div");
  menu.className = "add-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Context menu");
  menu.tabIndex = -1;

  (items || []).forEach((item) => {
    if (!item) return;
    if (item.type === "separator") {
      const separator = document.createElement("div");
      separator.className = "menu-separator";
      separator.setAttribute("role", "separator");
      menu.appendChild(separator);
      return;
    }

    const button = document.createElement("button");
    button.className = "menu-item";
    button.type = "button";
    button.textContent = item.label;
    button.setAttribute("role", "menuitem");
    button.disabled = !!item.disabled;
    button.addEventListener("click", () => {
      if (button.disabled) return;
      if (typeof item.fn === "function") item.fn();
      closeFloatingMenu();
    });
    menu.appendChild(button);
  });

  document.body.appendChild(menu);
  positionFloatingMenu(menu, { left, top, anchorEl, minLeft, minTop });
  attachFloatingMenuCloseHandlers(menu);
}

function showTabContextMenu(id, { left, top, anchorEl = null } = {}) {
  const tab = getTabRecord(id);
  if (!tab) return;

  const tabIds = getTabIdsInDomOrder();
  const tabIndex = tabIds.indexOf(id);
  const tabUrl = getCurrentTabURL(tab);
  const canCloseOthers = tabIds.length > 1;
  const canCloseTabsToRight = tabIndex >= 0 && tabIndex < tabIds.length - 1;

  showFloatingMenu(
    [
      { label: "Reload", fn: () => reloadTab(id), disabled: !tab.webview },
      { label: "Duplicate", fn: () => duplicateTab(id) },
      { label: "Open in New Window", fn: () => openTabInNewWindow(id), disabled: !tab.webview },
      { type: "separator" },
      { label: "Copy Tab URL", fn: () => copyTabURL(id), disabled: !tabUrl },
      { type: "separator" },
      { label: "Close Tabs to Right", fn: () => closeTabsToRight(id), disabled: !canCloseTabsToRight },
      { label: "Close Others", fn: () => closeTabsOtherThan(id), disabled: !canCloseOthers },
      { label: "Reopen Closed Tab", fn: reopenClosedTab, disabled: !canReopenClosedTab() },
      { type: "separator" },
      { label: "Close", fn: () => closeTab(id) },
    ],
    { left, top, anchorEl, minTop: 36 },
  );
}

function showAddMenu(llms, left, top, anchorEl = null) {
  const entries = Object.entries(llms || {});
  const items = entries.length
    ? entries.map(([key, url]) => ({
        label: key,
        fn: () => createTab(key, url),
      }))
    : [{ label: "No LLMs configured", disabled: true }];
  showFloatingMenu(items, { left, top, anchorEl, minTop: 36 });
}

function attachFloatingMenuCloseHandlers(menu) {
  openFloatingMenu = menu;
  floatingMenuOpenedAt = Date.now();
  floatingMenuReturnFocusEl =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const onPointerDownCapture = (e) => {
    if (!menu.contains(e.target)) closeFloatingMenu();
  };
  const onKeyDownCapture = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFloatingMenu();
    }
  };
  const onMenuKeyDown = (e) => {
    const items = getEnabledFloatingMenuItems(menu);
    if (!items.length) return;

    const currentIndex = items.indexOf(document.activeElement);
    const resolvedIndex = currentIndex >= 0 ? currentIndex : 0;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      focusFloatingMenuItem(menu, resolvedIndex + 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      focusFloatingMenuItem(menu, resolvedIndex - 1);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      focusFloatingMenuItem(menu, 0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      focusFloatingMenuItem(menu, items.length - 1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      if (!(document.activeElement instanceof HTMLElement)) return;
      if (!menu.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      document.activeElement.click();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      closeFloatingMenu();
    }
  };

  document.addEventListener("pointerdown", onPointerDownCapture, true);
  document.addEventListener("keydown", onKeyDownCapture, true);
  menu.addEventListener("keydown", onMenuKeyDown);
  requestAnimationFrame(() => focusFloatingMenuItem(menu, 0));

  cleanupFloatingMenu = () => {
    document.removeEventListener("pointerdown", onPointerDownCapture, true);
    document.removeEventListener("keydown", onKeyDownCapture, true);
    menu.removeEventListener("keydown", onMenuKeyDown);
  };
}

function closeFloatingMenu() {
  const returnFocusEl = floatingMenuReturnFocusEl;
  floatingMenuReturnFocusEl = null;
  if (cleanupFloatingMenu) {
    cleanupFloatingMenu();
    cleanupFloatingMenu = null;
  }
  if (openFloatingMenu && openFloatingMenu.isConnected) {
    openFloatingMenu.remove();
  }
  openFloatingMenu = null;
  floatingMenuOpenedAt = 0;
  if (returnFocusEl && returnFocusEl.isConnected) {
    try {
      returnFocusEl.focus({ preventScroll: true });
    } catch {
      returnFocusEl.focus();
    }
  }
}

function ensureTabbarControls() {
  if (!document.getElementById("addTab")) {
    const addBtn = document.createElement("div");
    addBtn.id = "addTab";
    addBtn.textContent = "+";
    addBtn.onclick = (e) => {
      e.preventDefault();
      createPickerTab();
    };
    addBtn.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hasPointerCoords = e.clientX > 0 || e.clientY > 0;
      showAddMenu(
        availableLLMs,
        hasPointerCoords ? e.clientX : undefined,
        hasPointerCoords ? e.clientY : undefined,
        addBtn,
      );
    };
    tabbar.appendChild(addBtn);
  }

  if (!document.getElementById("tabbarSpacer")) {
    const spacer = document.createElement("div");
    spacer.id = "tabbarSpacer";
    tabbar.appendChild(spacer);
  }

  if (!document.getElementById("downloadsBtn")) {
    const btn = document.createElement("button");
    btn.id = "downloadsBtn";
    btn.type = "button";
    btn.innerHTML = `
      <span class="downloads-icon">↓</span>
      <span id="downloadsBadge"></span>
    `;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleDownloadsPanel();
    });
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleDownloadsPanel();
    });
    tabbar.appendChild(btn);
  }

  ensureWindowControls();
  renderDownloadsBadge();
}

// -----------------------------------------------------
// INITIAL LOAD (startup tab)
// -----------------------------------------------------
const getLastURLPromise =
  typeof api.getLastURL === "function"
    ? api.getLastURL()
    : Promise.resolve(null);
const getSettingsPromise =
  typeof api.getSettings === "function"
    ? api.getSettings()
    : Promise.resolve({});
const getWindowIdPromise =
  typeof api.getWindowId === "function"
    ? api.getWindowId()
    : Promise.resolve(null);
const consumeTabWindowInitPromise =
  typeof api.consumeTabWindowInit === "function"
    ? api.consumeTabWindowInit()
    : Promise.resolve(null);

Promise.all([
  getLastURLPromise,
  getSettingsPromise,
  getWindowIdPromise,
  consumeTabWindowInitPromise,
]).then(([url, settings, windowId, initPayload]) => {
  currentWindowId = Number(windowId) || null;
  setChromelessMode(settings?.hideSystemBorders === true);

  if (initPayload?.url) {
    const initUrl = String(initPayload.url);
    const initLabel = inferLLMKeyFromURL(initUrl, initPayload.llmKey || settings?.activeLLMKey);
    const initPrompt = sanitizePromptText(initPayload.promptText);
    createTab(initLabel, initUrl, { promptText: initPrompt });
    return;
  }

  const startURL = url || FALLBACK_LLMS.chatgpt;
  const label = inferLLMKeyFromURL(startURL, settings?.activeLLMKey);
  createTab(label, startURL);
});

ensureTabbarControls();
startDownloadPolling();

// -----------------------------------------------------
// LLM LIST FOR THE "+" BUTTON
// -----------------------------------------------------
if (typeof api.onLoadLLMList === "function") {
  api.onLoadLLMList((llms) => {
    if (llms && Object.keys(llms).length > 0) {
      availableLLMs = llms;
    }
    ensureTabbarControls();
    refreshDownloads();
  });
}

if (typeof api.onOpenLLMTab === "function") {
  api.onOpenLLMTab((payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const targetUrl = typeof payload.url === "string" ? payload.url.trim() : "";
    if (!isSafeHttpUrl(targetUrl)) return;
    const requestedKey =
      typeof payload.llmKey === "string" && payload.llmKey.trim()
        ? payload.llmKey.trim()
        : "chatgpt";
    const label = inferLLMKeyFromURL(targetUrl, requestedKey);
    const promptText = sanitizePromptText(payload.promptText);
    createTab(label, targetUrl, { promptText });
  });
}

if (typeof api.onTabTransferRemove === "function") {
  cleanupTabTransferListener = api.onTabTransferRemove(async (tabId) => {
    const exists = tabs.some((t) => t.id === tabId);
    if (!exists) return;
    const isLastTab = tabs.length === 1 && tabs[0]?.id === tabId;
    if (isLastTab) {
      closeTab(tabId, { createPickerWhenEmpty: false, trackHistory: false });
      if (typeof api.windowClose === "function") {
        await api.windowClose();
      }
      return;
    }
    closeTab(tabId, { trackHistory: false });
  });
}

tabbar.addEventListener("contextmenu", (e) => {
  const clickedTab = e.target.closest(".tab");
  const clickedAdd = e.target.closest("#addTab");
  const clickedDownloads = e.target.closest("#downloadsBtn");
  if (clickedTab || clickedAdd || clickedDownloads) return;
  e.preventDefault();
  const hasPointerCoords = e.clientX > 0 || e.clientY > 0;
  showAddMenu(
    availableLLMs,
    hasPointerCoords ? e.clientX : undefined,
    hasPointerCoords ? e.clientY : undefined,
    tabbar,
  );
});

tabbar.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

  const payload = readDraggedTabPayload(e.dataTransfer);
  const isPotential = !!payload || hasPotentialTabPayload(e.dataTransfer) || !!activeTabDrag;
  if (!isPotential) {
    tabbar.classList.remove("drop-target");
    return;
  }

  if (!payload) {
    if (activeTabDrag) {
      placeTabButtonAtClientX(activeTabDrag.tabId, e.clientX);
    } else {
      tabbar.classList.add("drop-target");
    }
    return;
  }
  tabbar.classList.toggle("drop-target", payload.sourceWindowId !== currentWindowId);

  if (
    payload.sourceWindowId === currentWindowId &&
    activeTabDrag &&
    activeTabDrag.tabId === payload.sourceTabId
  ) {
    placeTabButtonAtClientX(payload.sourceTabId, e.clientX);
  }
});

tabbar.addEventListener("dragleave", (e) => {
  const rect = tabbar.getBoundingClientRect();
  const inside =
    e.clientX >= rect.left &&
    e.clientX <= rect.right &&
    e.clientY >= rect.top &&
    e.clientY <= rect.bottom;
  if (!inside) {
    tabbar.classList.remove("drop-target");
  }
});

tabbar.addEventListener("drop", async (e) => {
  e.preventDefault();
  e.stopPropagation();

  let payload = readDraggedTabPayload(e.dataTransfer);
  if (!payload && typeof api.getTabDragSession === "function") {
    try {
      const fallback = await api.getTabDragSession();
      if (fallback && typeof fallback === "object") payload = fallback;
    } catch {}
  }
  tabbar.classList.remove("drop-target");
  if (!payload) return;

  if (payload.sourceWindowId === currentWindowId) {
    if (activeTabDrag) activeTabDrag.droppedInsideWindow = true;
    placeTabButtonAtClientX(payload.sourceTabId, e.clientX);
    syncTabOrderFromDOM();
    return;
  }

  const insertedId =
    payload.kind === "picker" ? createPickerTab() : createTab(payload.llmKey, payload.url);
  placeTabButtonAtClientX(insertedId, e.clientX);
  syncTabOrderFromDOM();
  if (typeof api.completeTabTransfer === "function") {
    await api.completeTabTransfer({
      sourceWindowId: payload.sourceWindowId,
      sourceTabId: payload.sourceTabId,
    });
  }
  if (typeof api.clearTabDragSession === "function") {
    await api.clearTabDragSession({
      sourceWindowId: payload.sourceWindowId,
      sourceTabId: payload.sourceTabId,
    });
  }
});

// -----------------------------------------------------
// KEYBOARD SHORTCUT SUPPORT
// -----------------------------------------------------
window.addEventListener("keydown", (e) => {
  const key = String(e.key || "").toLowerCase();

  if (e.ctrlKey && e.shiftKey && key === "t") {
    e.preventDefault();
    reopenClosedTab();
  }

  if (e.ctrlKey && !e.shiftKey && key === "t") {
    e.preventDefault();
    createPickerTab();
  }

  if (e.ctrlKey && key === "w") {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
  }

  if (e.key === "F5" || (e.ctrlKey && key === "r")) {
    e.preventDefault();
    reloadTab(activeTabId);
  }

  if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    cycleTab(+1);
  }

  if (e.ctrlKey && e.shiftKey && e.key === "Tab") {
    e.preventDefault();
    cycleTab(-1);
  }
});

// -----------------------------------------------------
// TAB CYCLING (Ctrl+Tab)
// -----------------------------------------------------
function cycleTab(dir) {
  if (!activeTabId || tabs.length === 0) return;

  const idx = tabs.findIndex((t) => t.id === activeTabId);
  const next = (idx + dir + tabs.length) % tabs.length;
  activateTab(tabs[next].id);
}

window.addEventListener("resize", () => {
  const active = tabs.find((t) => t.id === activeTabId);
  if (active?.webview) nudgeWebviewResize(active.webview);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "F12") {
    const active = tabs.find((t) => t.id === activeTabId);
    if (active?.webview) active.webview.openDevTools();
  }
});

window.addEventListener("beforeunload", () => {
  if (cleanupWindowStateListener) {
    cleanupWindowStateListener();
    cleanupWindowStateListener = null;
  }
  if (cleanupTabTransferListener) {
    cleanupTabTransferListener();
    cleanupTabTransferListener = null;
  }
});
