const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  shell,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  session,
} = require("electron");
// --- ENGINE SWITCHES (Must be before app.whenReady) ---
// Fixes videos not playing automatically
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const path = require("path");
const fs = require("fs");
const os = require("os");
const isDevMode = process.env.LLM_TRAY_DEV_ICON === "1" || !app.isPackaged;

if (isDevMode) {
  // Keep dev runs isolated so they can run side-by-side with packaged installs.
  app.setPath("userData", `${app.getPath("userData")}-dev`);
  app.setName("LLM Tray Dev");
  // Distinguish window grouping/icon identity in Linux task managers (KDE/GNOME).
  if (process.platform === "linux") app.commandLine.appendSwitch("class", "llm-tray-dev");
  if (process.platform === "linux" && typeof app.setDesktopName === "function") {
    app.setDesktopName("llm-tray-dev");
  }
}

// -----------------------------------------------------------------------------
// SINGLE INSTANCE & PROTOCOL REGISTRATION
// -----------------------------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // If this is the second instance, check for the toggle flag before quitting
  if (process.argv.includes("--toggle")) {
    // This will trigger 'second-instance' in the primary process
  }
  app.quit();
} else {
  app.on("second-instance", (event, commandLine) => {
    console.log("[Second Instance] Command line:", commandLine);

    // 1. Handle the --toggle flag
    if (commandLine.includes("--toggle")) {
      toggleWindow();
      return;
    }

    // 2. Focus main window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }

    // 3. Handle OAuth URLs
    const url = commandLine.pop();
    console.log("[Second Instance] Extracted URL:", url);
    if (url && url.startsWith("llmtray://")) {
      const { startOAuthFlow } = require("./oauth");
      startOAuthFlow(url);
    }
  });

  if (!isDevMode) {
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient("llmtray", process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      }
    } else {
      app.setAsDefaultProtocolClient("llmtray");
    }
  }
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  const { startOAuthFlow } = require("./oauth");
  startOAuthFlow(url);
});

// -----------------------------------------------------------------------------
// GLOBALS / HELPERS
// -----------------------------------------------------------------------------
let tray;
let mainWindow;
let isQuitting = false;
let captureMode = false;
let settingsCache = null;
let settingsCacheTime = 0;
const pendingTabWindowInit = new Map();
let activeTabDragSession = null;
const CACHE_TTL = 5000; // 5 seconds cache

const isLinux = () => process.platform === "linux";
const isWindows = () => process.platform === "win32";
const isMac = () => process.platform === "darwin";
// Keep tray dev styling tied to unpackaged runs (e.g. `npm run start`),
// unless explicitly forced on with an env var.
let devTrayIconCache = null;

const settingsPath = path.join(app.getPath("userData"), "settings.json");
module.exports = { mainWindow };

function loadSettings() {
  const now = Date.now();
  if (settingsCache && now - settingsCacheTime < CACHE_TTL) {
    return settingsCache;
  }
  try {
    settingsCache = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    settingsCacheTime = now;
    return settingsCache;
  } catch {
    settingsCache = {};
    settingsCacheTime = now;
    return {};
  }
}

function saveSettings(s) {
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
  settingsCache = s;
  settingsCacheTime = Date.now();
}

const BASE_SEARCH_ENGINES = {
  google: "https://www.google.com/search?q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  bing: "https://www.bing.com/search?q=%s",
  brave: "https://search.brave.com/search?q=%s",
  kagi: "https://kagi.com/search?q=%s",
};
let SEARCH_ENGINES = { ...BASE_SEARCH_ENGINES };

const BASE_LLMS = {
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/",
  claude: "https://claude.ai/",
  grok: "https://grok.com/",
};
const BASE_LLM_PROMPT_URLS = {
  chatgpt: "https://chatgpt.com/?q=%s",
  gemini: "https://gemini.google.com/app?q=%s",
  claude: "https://claude.ai/new?q=%s",
  grok: "https://grok.com/?q=%s",
};
let LLM_URLS = { ...BASE_LLMS };
let LLM_KEYS = Object.keys(LLM_URLS);
let activeLLMKey = "chatgpt";
let unreadBadges = {};
const MAX_PROMPT_TEXT_CHARS = 4000;
const getMenuIcon = (name) => {
  const settings = loadSettings();
  if (settings.showMenuIcons === false) return undefined;

  // This path must match exactly where you put the icons in your project folder
  const p = path.join(__dirname, "assets", "icons", `${name}.png`);

  if (!fs.existsSync(p)) {
    // Helpful for debugging during development
    console.error(`Icon missing at: ${p}`);
    return undefined;
  }

  const size = settings.menuIconSize ? parseInt(settings.menuIconSize) : 16;
  return nativeImage.createFromPath(p).resize({ width: size, height: size });
};

function buildDevTrayIcon(baseIconPath) {
  if (devTrayIconCache) return devTrayIconCache;
  const baseIcon = nativeImage.createFromPath(baseIconPath);
  if (baseIcon.isEmpty()) return baseIconPath;

  const { width, height } = baseIcon.getSize();
  const bitmap = Buffer.from(baseIcon.toBitmap());

  // Tint the icon so the dev instance is visually distinct in the tray.
  for (let i = 0; i < bitmap.length; i += 4) {
    const b = bitmap[i];
    const g = bitmap[i + 1];
    const r = bitmap[i + 2];
    const a = bitmap[i + 3];
    if (a === 0) continue;

    // Shift to a warm orange/red tint so dev mode is easy to spot.
    bitmap[i] = Math.min(255, Math.round(b * 0.22 + 10));
    bitmap[i + 1] = Math.min(255, Math.round(g * 0.35 + 60));
    bitmap[i + 2] = Math.min(255, Math.round(r * 0.45 + 140));
  }

  const radius = Math.max(2, Math.round(Math.min(width, height) * 0.16));
  const centerX = width - radius - 2;
  const centerY = height - radius - 2;
  const outlineRadiusSq = (radius + 1) * (radius + 1);
  const radiusSq = radius * radius;

  for (
    let y = Math.max(0, centerY - radius - 1);
    y <= Math.min(height - 1, centerY + radius + 1);
    y++
  ) {
    for (
      let x = Math.max(0, centerX - radius - 1);
      x <= Math.min(width - 1, centerX + radius + 1);
      x++
    ) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distSq = dx * dx + dy * dy;
      if (distSq > outlineRadiusSq) continue;

      const idx = (y * width + x) * 4;
      if (distSq > radiusSq) {
        bitmap[idx] = 255;
        bitmap[idx + 1] = 255;
        bitmap[idx + 2] = 255;
        bitmap[idx + 3] = 255;
      } else {
        bitmap[idx] = 10;
        bitmap[idx + 1] = 85;
        bitmap[idx + 2] = 255;
        bitmap[idx + 3] = 255;
      }
    }
  }

  devTrayIconCache = nativeImage.createFromBitmap(bitmap, { width, height });
  return devTrayIconCache;
}

function getTrayIcon() {
  const baseIconPath = path.join(__dirname, "icon.png");
  if (!isDevMode) return baseIconPath;
  return buildDevTrayIcon(baseIconPath);
}

function formatLLMLabel(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function inferLLMKeyFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const lowerUrl = url.toLowerCase();

  for (const key of LLM_KEYS) {
    const candidate = (LLM_URLS[key] || "").toLowerCase();
    if (candidate && lowerUrl.startsWith(candidate)) return key;
  }

  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("chatgpt.com") || host.includes("openai.com"))
      return "chatgpt";
    if (host.includes("gemini.google.com")) return "gemini";
    if (host.includes("claude.ai")) return "claude";
    if (host.includes("grok.com") || host.includes("x.ai")) return "grok";
  } catch {}

  return null;
}

const TRUSTED_RENDERER_PATHS = new Set(
  ["index.html", "settings.html", "toolbar.html", "popup.html"].map((file) =>
    path.normalize(path.join(__dirname, "views", file)),
  ),
);

const NAVIGATION_ALLOWLIST = [
  "chatgpt.com",
  "openai.com",
  "gemini.google.com",
  "claude.ai",
  "grok.com",
  "x.ai",
  "accounts.google.com",
  "accounts.x.com",
];

const POPUP_HOST_ALLOWLIST = [
  "chatgpt.com",
  "openai.com",
  "google.com",
  "accounts.google.com",
  "accounts.x.com",
  "grok.com",
  "x.ai",
  "x.com",
];

const AUTH_PATH_HINTS = [
  "/oauth",
  "/auth",
  "/authorize",
  "/signin",
  "/login",
  "/callback",
];

function parseExternalURL(rawUrl, { allowMailto = false } = {}) {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 4096) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed;
    if (allowMailto && parsed.protocol === "mailto:") return parsed;
  } catch {}
  return null;
}

function parseHttpURL(rawUrl) {
  return parseExternalURL(rawUrl);
}

function hostnameMatches(hostname, allowedHost) {
  return hostname === allowedHost || hostname.endsWith(`.${allowedHost}`);
}

function isAllowedInAppNavigation(rawUrl) {
  const parsed = parseHttpURL(rawUrl);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return NAVIGATION_ALLOWLIST.some((allowed) =>
    hostnameMatches(host, allowed),
  );
}

function isAllowedPopupUrl(rawUrl) {
  const parsed = parseHttpURL(rawUrl);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  if (!POPUP_HOST_ALLOWLIST.some((allowed) => hostnameMatches(host, allowed))) {
    return false;
  }

  if (host === "accounts.google.com" || host === "accounts.x.com") return true;
  const pathPart = parsed.pathname.toLowerCase();
  if (AUTH_PATH_HINTS.some((hint) => pathPart.includes(hint))) return true;

  const query = parsed.search.toLowerCase();
  return (
    query.includes("client_id=") ||
    query.includes("response_type=") ||
    query.includes("redirect_uri=")
  );
}

function openExternalSafe(rawUrl, options = {}) {
  const parsed = parseExternalURL(rawUrl, options);
  if (!parsed) return false;
  shell.openExternal(parsed.toString());
  return true;
}

function getSenderURL(event) {
  return event?.senderFrame?.url || event?.sender?.getURL?.() || "";
}

function getEventWindow(event) {
  const sender = event?.sender;
  if (!sender) return null;
  const win = BrowserWindow.fromWebContents(sender);
  if (!win || win.isDestroyed()) return null;
  return win;
}

function sanitizeWindowId(value) {
  return sanitizeNumber(value, { min: 1, max: 1_000_000, integer: true });
}

function toFilePathFromURL(fileUrl) {
  try {
    const parsed = new URL(fileUrl);
    if (parsed.protocol !== "file:") return null;
    let pathname = decodeURIComponent(parsed.pathname);
    if (isWindows() && pathname.startsWith("/")) pathname = pathname.slice(1);
    return path.normalize(pathname);
  } catch {
    return null;
  }
}

function isTrustedIpcSender(event) {
  const senderURL = getSenderURL(event);
  if (!senderURL) return false;
  const senderPath = toFilePathFromURL(senderURL);
  return !!senderPath && TRUSTED_RENDERER_PATHS.has(senderPath);
}

function ensureTrustedIpcSender(event, channel) {
  if (isTrustedIpcSender(event)) return;
  const senderURL = getSenderURL(event) || "unknown";
  console.warn(`[IPC] Blocked ${channel} from ${senderURL}`);
  throw new Error("Unauthorized IPC sender");
}

function handleTrustedIpc(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    ensureTrustedIpcSender(event, channel);
    return handler(event, ...args);
  });
}

function onTrustedIpc(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      ensureTrustedIpcSender(event, channel);
    } catch {
      return;
    }
    handler(event, ...args);
  });
}

function sanitizeString(value, max = 256, { allowEmpty = false } = {}) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) return null;
  if (trimmed.length > max) return null;
  return trimmed;
}

function sanitizeNumber(value, { min, max, integer = false } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (typeof min === "number" && num < min) return null;
  if (typeof max === "number" && num > max) return null;
  if (integer && !Number.isInteger(num)) return null;
  return num;
}

function sanitizeShortcut(value) {
  const shortcut = sanitizeString(value, 80);
  if (!shortcut) return null;
  if (!/^[A-Za-z0-9+ ]+$/.test(shortcut)) return null;
  return shortcut;
}

function sanitizeUrl(value) {
  const parsed = parseHttpURL(value);
  return parsed ? parsed.toString() : null;
}

function sanitizePromptText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_PROMPT_TEXT_CHARS);
}

function sanitizeTabDragSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sourceWindowId = sanitizeWindowId(value.sourceWindowId);
  const sourceTabId = sanitizeString(value.sourceTabId, 128);
  if (!sourceWindowId || !sourceTabId) return null;

  const kind = value.kind === "picker" ? "picker" : "webview";
  const llmKey = sanitizeString(value.llmKey, 64) || (kind === "picker" ? "new tab" : "chatgpt");

  if (kind === "picker") {
    return {
      sourceWindowId,
      sourceTabId,
      kind,
      llmKey,
      url: null,
    };
  }

  const url = sanitizeUrl(value.url);
  if (!url) return null;
  return {
    sourceWindowId,
    sourceTabId,
    kind,
    llmKey,
    url,
  };
}

function sanitizeListOfNames(value, maxItems = 64) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const out = [];
  value.slice(0, maxItems).forEach((item) => {
    const name = sanitizeString(item, 64);
    if (!name) return;
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  });
  return out;
}

function sanitizeCustomSearchEngines(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  const seen = new Set();
  value.slice(0, 32).forEach((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const name = sanitizeString(item.name, 64);
    const template = sanitizeString(item.template, 2048);
    if (!name || !template || !template.includes("%s")) return;
    const parsedTemplate = parseHttpURL(template.replace("%s", "test"));
    if (!parsedTemplate) return;
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    const entry = { name: normalized, template };
    if (item.visible === false) entry.visible = false;
    out.push(entry);
  });
  return out;
}

function sanitizeLLMList(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  const seen = new Set();
  value.slice(0, 64).forEach((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const name = sanitizeString(item.name, 64);
    const url = sanitizeUrl(item.url);
    if (!name || !url) return;
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ name, url });
  });
  return out;
}

function sanitizeLLMTarget(value) {
  const text = sanitizeString(value, 2048);
  if (!text) return null;
  const key = text.toLowerCase();
  if (LLM_URLS[key]) return key;
  return sanitizeUrl(text);
}

function sanitizeDownloadId(value) {
  return sanitizeString(value, 128);
}

function sanitizeSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return {};

  const out = {};

  if (typeof patch.autoLaunch === "boolean") out.autoLaunch = patch.autoLaunch;
  if (typeof patch.showOnStartup === "boolean")
    out.showOnStartup = patch.showOnStartup;
  if (typeof patch.enableTabs === "boolean") out.enableTabs = patch.enableTabs;
  if (typeof patch.hideSystemBorders === "boolean")
    out.hideSystemBorders = patch.hideSystemBorders;
  if (typeof patch.showMenuIcons === "boolean")
    out.showMenuIcons = patch.showMenuIcons;

  const shortcut = sanitizeShortcut(patch.shortcut);
  if (shortcut) out.shortcut = shortcut;

  const centerShortcut = sanitizeShortcut(patch.centerShortcut);
  if (centerShortcut) out.centerShortcut = centerShortcut;

  const settingsShortcut = sanitizeShortcut(patch.settingsShortcut);
  if (settingsShortcut) out.settingsShortcut = settingsShortcut;

  if (typeof patch.theme === "string") {
    const theme = patch.theme.trim().toLowerCase();
    if (["auto", "light", "dark"].includes(theme)) out.theme = theme;
  }

  const iconSize = sanitizeNumber(patch.menuIconSize, {
    min: 16,
    max: 24,
    integer: true,
  });
  if (iconSize && [16, 20, 24].includes(iconSize)) out.menuIconSize = iconSize;

  const hiddenSearch = sanitizeListOfNames(patch.searchEnginesHidden);
  if (hiddenSearch) out.searchEnginesHidden = hiddenSearch;

  const customSearch = sanitizeCustomSearchEngines(patch.customSearchEngines);
  if (customSearch) out.customSearchEngines = customSearch;

  const hiddenLLMs = sanitizeListOfNames(patch.hiddenLLMs);
  if (hiddenLLMs) out.hiddenLLMs = hiddenLLMs;

  const customLLMs = sanitizeLLMList(patch.customLLMs);
  if (customLLMs) out.customLLMs = customLLMs;

  const orderedLLMs = sanitizeLLMList(patch.orderedLLMs);
  if (orderedLLMs) out.orderedLLMs = orderedLLMs;

  const activeLLMKey = sanitizeString(patch.activeLLMKey, 64);
  if (activeLLMKey) out.activeLLMKey = activeLLMKey.toLowerCase();

  const defaultLLM = sanitizeString(patch.defaultLLM, 64);
  if (defaultLLM) out.defaultLLM = defaultLLM.toLowerCase();

  const windowWidth = sanitizeNumber(patch.windowWidth, {
    min: 640,
    max: 5000,
    integer: true,
  });
  if (windowWidth) out.windowWidth = windowWidth;

  const windowHeight = sanitizeNumber(patch.windowHeight, {
    min: 480,
    max: 5000,
    integer: true,
  });
  if (windowHeight) out.windowHeight = windowHeight;

  const lastVisitedURL = sanitizeUrl(patch.lastVisitedURL);
  if (lastVisitedURL) out.lastVisitedURL = lastVisitedURL;

  const zoomLevel = sanitizeNumber(patch.zoomLevel, { min: -5, max: 5 });
  if (zoomLevel !== null) out.zoomLevel = zoomLevel;

  const userAgent = sanitizeString(patch.userAgent, 1024, { allowEmpty: true });
  if (userAgent !== null) out.userAgent = userAgent;

  return out;
}

const downloadSessions = new Set();
const downloadRecords = new Map();
const activeDownloadItems = new Map();
const downloadOrder = [];
const MAX_DOWNLOAD_HISTORY = 100;

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

function truncateLabel(text, max = 56) {
  if (!text || text.length <= max) return text || "";
  return `${text.slice(0, max - 1)}…`;
}

function makeUniqueSavePath(downloadsDir, filename) {
  const safeName = filename && filename.trim() ? filename.trim() : "download.bin";
  const parsed = path.parse(safeName);
  let candidate = path.join(downloadsDir, safeName);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    const next = `${parsed.name} (${counter})${parsed.ext || ""}`;
    candidate = path.join(downloadsDir, next);
    counter += 1;
  }
  return candidate;
}

function pruneDownloadHistory() {
  while (downloadOrder.length > MAX_DOWNLOAD_HISTORY) {
    const oldest = downloadOrder.shift();
    if (!oldest) break;
    if (activeDownloadItems.has(oldest)) continue;
    downloadRecords.delete(oldest);
  }
}

function updateDownloadRecord(id, patch) {
  const existing = downloadRecords.get(id);
  if (!existing) return;
  downloadRecords.set(id, { ...existing, ...patch, updatedAt: Date.now() });
}

function trackDownloadForSession(ses) {
  if (!ses || downloadSessions.has(ses)) return;
  downloadSessions.add(ses);

  ses.on("will-download", (_event, item) => {
    const id = `dl_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const downloadsDir = app.getPath("downloads");
    const filename = item.getFilename();
    const savePath = makeUniqueSavePath(downloadsDir, filename);
    item.setSavePath(savePath);

    const initial = {
      id,
      filename,
      savePath,
      url: item.getURL(),
      state: "starting",
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      endedAt: null,
    };
    downloadRecords.set(id, initial);
    activeDownloadItems.set(id, item);
    downloadOrder.push(id);
    pruneDownloadHistory();

    item.on("updated", (_evt, state) => {
      updateDownloadRecord(id, {
        state: state === "interrupted" ? "interrupted" : item.isPaused() ? "paused" : "downloading",
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
      });
    });

    item.once("done", (_evt, state) => {
      updateDownloadRecord(id, {
        state:
          state === "completed"
            ? "completed"
            : state === "cancelled"
              ? "cancelled"
              : "failed",
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        endedAt: Date.now(),
      });
      activeDownloadItems.delete(id);
      pruneDownloadHistory();
    });
  });
}

function startMediaDownload(sourceContents, mediaUrl) {
  if (!sourceContents || !mediaUrl) return;
  try {
    sourceContents.downloadURL(mediaUrl);
  } catch (error) {
    console.error("[download] Failed to start download:", error);
  }
}

function getRecentDownloads(limit = 8) {
  const ids = [...downloadOrder].reverse();
  return ids
    .map((id) => downloadRecords.get(id))
    .filter(Boolean)
    .slice(0, limit);
}

function clearFinishedDownloads() {
  for (const id of [...downloadOrder]) {
    const rec = downloadRecords.get(id);
    if (!rec) continue;
    if (rec.state === "downloading" || rec.state === "paused" || rec.state === "starting")
      continue;
    if (activeDownloadItems.has(id)) continue;
    downloadRecords.delete(id);
  }
  const remaining = downloadOrder.filter((id) => downloadRecords.has(id));
  downloadOrder.length = 0;
  downloadOrder.push(...remaining);
}

function buildDownloadsSubmenu() {
  const recent = getRecentDownloads(8);
  const hasClearable = recent.some(
    (rec) =>
      rec.state !== "downloading" &&
      rec.state !== "paused" &&
      rec.state !== "starting",
  );
  const items = recent.map((rec) => {
    const total = rec.totalBytes || 0;
    const received = rec.receivedBytes || 0;
    const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;

    let status = rec.state;
    if (rec.state === "downloading") {
      status = pct !== null ? `${pct}%` : `${formatBytes(received)}`;
    } else if (rec.state === "completed") {
      status = "Done";
    } else if (rec.state === "failed") {
      status = "Failed";
    } else if (rec.state === "cancelled") {
      status = "Cancelled";
    } else if (rec.state === "interrupted") {
      status = "Interrupted";
    } else if (rec.state === "paused") {
      status = "Paused";
    }

    const label = `${truncateLabel(rec.filename || "download")} - ${status}`;
    const clickable = rec.savePath && rec.state === "completed";

    return {
      label,
      enabled: !!clickable,
      click: () => {
        if (clickable) shell.showItemInFolder(rec.savePath);
      },
    };
  });

  if (items.length === 0) {
    items.push({ label: "No downloads yet", enabled: false });
  }

  const activeIds = [...activeDownloadItems.keys()];
  items.push({ type: "separator" });
  items.push({
    label: "Open Downloads Folder",
    click: () => shell.openPath(app.getPath("downloads")),
  });
  items.push({
    label: "Clear Finished",
    enabled: hasClearable,
    click: () => clearFinishedDownloads(),
  });
  items.push({
    label: "Cancel Active Downloads",
    enabled: activeIds.length > 0,
    click: () => {
      activeIds.forEach((id) => {
        const item = activeDownloadItems.get(id);
        if (item) item.cancel();
      });
    },
  });
  return items;
}

function buildLLMPromptURL(llmKey, promptText) {
  const safePrompt = sanitizePromptText(promptText);
  if (!safePrompt) return null;

  const template = BASE_LLM_PROMPT_URLS[llmKey];
  if (template && template.includes("%s")) {
    const templatedUrl = sanitizeUrl(
      template.replace("%s", encodeURIComponent(safePrompt)),
    );
    if (templatedUrl) return templatedUrl;
  }

  const baseUrl = LLM_URLS[llmKey];
  const parsed = parseHttpURL(baseUrl);
  if (!parsed) return null;
  parsed.searchParams.set("q", safePrompt);
  return parsed.toString();
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

function seedPromptInWebContents(contents, promptText) {
  const safePrompt = sanitizePromptText(promptText);
  if (!safePrompt || !contents || contents.isDestroyed()) return;
  const script = buildPromptSeedScript(safePrompt);
  let seeded = false;
  let inFlight = false;
  const runSeed = () => {
    if (seeded || inFlight || !contents || contents.isDestroyed()) return;
    inFlight = true;
    contents
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

function isTabHostWindow(win) {
  if (!win || win.isDestroyed()) return false;
  const currentURL = win.webContents.getURL();
  const filePath = toFilePathFromURL(currentURL);
  const tabHostPath = path.normalize(path.join(__dirname, "views", "index.html"));
  return !!filePath && filePath === tabHostPath;
}

function openSelectionInLLM(llmKey, selectionText, { hostWindow = null } = {}) {
  const safePrompt = sanitizePromptText(selectionText);
  if (!safePrompt) return;

  const promptUrl = buildLLMPromptURL(llmKey, safePrompt);
  if (!promptUrl) return;

  const settings = loadSettings();
  const requestedHost = hostWindow && !hostWindow.isDestroyed() ? hostWindow : null;
  const fallbackHost = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const candidateHost = requestedHost || fallbackHost;

  if (settings.enableTabs) {
    const tabHost = isTabHostWindow(candidateHost)
      ? candidateHost
      : isTabHostWindow(fallbackHost)
        ? fallbackHost
        : null;
    if (tabHost && !tabHost.webContents.isDestroyed()) {
      tabHost.webContents.send("open-llm-tab", {
        llmKey,
        url: promptUrl,
        promptText: safePrompt,
      });
      tabHost.show();
      tabHost.focus();
      return;
    }
  }

  createLLMWindow(promptUrl, { promptText: safePrompt });
}

function showRichContextMenu(
  sourceContents,
  params,
  { isTabWebview = false, hostWindow = null } = {},
) {
  const menuWindow =
    hostWindow && !hostWindow.isDestroyed()
      ? hostWindow
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : null;
  if (!menuWindow) return;

  const menuItems = [];

  if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
    params.dictionarySuggestions.forEach((suggestion) => {
      menuItems.push({
        label: suggestion,
        click: () => sourceContents.replaceMisspelling(suggestion),
      });
    });
    menuItems.push({ type: "separator" });
  }

  menuItems.push(
    { label: "Cut", role: "cut", icon: getMenuIcon("cut") },
    { label: "Copy", role: "copy", icon: getMenuIcon("copy") },
    { label: "Paste", role: "paste", icon: getMenuIcon("paste") },
    { type: "separator" },
  );

  if (params.srcURL) {
    menuItems.push({
      label: "Download Media…",
      click: async () => {
        startMediaDownload(sourceContents, params.srcURL);
      },
    });
    menuItems.push({ type: "separator" });
  }

  const activeUrl =
    sourceContents.getURL() || params.pageURL || loadSettings().lastVisitedURL;
  const currentLLMKey = inferLLMKeyFromUrl(activeUrl) || activeLLMKey;

  menuItems.push(
    {
      label: "Open Chat in Browser",
      enabled: !!parseExternalURL(activeUrl, { allowMailto: true }),
      icon: getMenuIcon("external"),
      click: () => {
        openExternalSafe(activeUrl, { allowMailto: true });
      },
    },
    {
      label: "Open in New Window",
      enabled: !!activeUrl,
      icon: getMenuIcon("external"),
      click: () => {
        if (activeUrl) createLLMWindow(activeUrl);
      },
    },
    { type: "separator" },
    {
      label: "Hide",
      click: () => mainWindow.hide(),
      icon: getMenuIcon("hide"),
    },
    {
      label: "Center Window",
      click: centerWindow,
      icon: getMenuIcon("center"),
    },
    { type: "separator" },
    { label: "Settings", click: openSettings, icon: getMenuIcon("settings") },
    { type: "separator" },
    {
      label: "Reload",
      click: () => sourceContents.reload(),
      icon: getMenuIcon("reload"),
    },
    { type: "separator" },
  );

  const selectedText = sanitizePromptText(params.selectionText);
  if (selectedText) {
    menuItems.push({
      label: "Search With",
      submenu: Object.entries(SEARCH_ENGINES).map(([name, template]) => ({
        label: name.charAt(0).toUpperCase() + name.slice(1),
        click: () => {
          const searchUrl = template.replace(
            "%s",
            encodeURIComponent(selectedText),
          );
          openExternalSafe(searchUrl);
        },
      })),
    });
    menuItems.push({
      label: "Open LLM With",
      submenu: LLM_KEYS.map((key) => ({
        label: formatLLMLabel(key),
        click: () => openSelectionInLLM(key, selectedText, { hostWindow: menuWindow }),
      })),
    });
  }

  if (params.linkURL) {
    menuItems.push({
      label: "Open Link in Browser",
      click: () => openExternalSafe(params.linkURL, { allowMailto: true }),
    });
    menuItems.push({
      label: "Copy Link Address",
      click: () => clipboard.writeText(params.linkURL),
    });
  }

  menuItems.push({
    label: "Switch LLM",
    icon: getMenuIcon("layers"),
    submenu: LLM_KEYS.map((key) => ({
      label:
        key === currentLLMKey ? `✓ ${formatLLMLabel(key)}` : formatLLMLabel(key),
      click: () => {
        if (isTabWebview) {
          const url = LLM_URLS[key];
          if (!url) return;
          sourceContents.loadURL(url);
          activeLLMKey = key;
          const s = loadSettings();
          s.activeLLMKey = key;
          s.lastVisitedURL = url;
          saveSettings(s);
          if (tray) tray.setContextMenu(Menu.buildFromTemplate(getLLMTrayMenu()));
          return;
        }
        openLLM(key);
      },
    })),
  });

  Menu.buildFromTemplate(menuItems).popup({ window: menuWindow });
}

async function openSettingsOverlayInMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  const settingsViewPath = path
    .join(__dirname, "views/settings.html")
    .replace(/\\/g, "/");
  const preloadPath = path.join(__dirname, "preload.js").replace(/\\/g, "/");

  try {
    await mainWindow.webContents.executeJavaScript(`
      (function() {
        const existing = document.getElementById('settingsOverlay');
        if (existing) {
          existing.remove();
          return;
        }
        
        const overlay = document.createElement('div');
        overlay.id = 'settingsOverlay';
        overlay.style.cssText = "position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); z-index:999999; display:flex; align-items:center; justify-content:center; padding:20px; backdrop-filter:blur(4px); opacity:0; transition: opacity 0.2s ease-out;";
        
        const container = document.createElement('div');
        container.style.cssText = "position:relative; width:95%; max-width:1600px; height:90%; background:#1b1b1b; border-radius:8px; border:1px solid #333; display:flex; flex-direction:column; box-shadow:0 20px 50px rgba(0,0,0,0.6); overflow:hidden; transform: scale(0.95); transition: transform 0.2s ease-out;";

        const header = document.createElement('div');
        header.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:12px 25px; background:#202020; border-bottom:1px solid #333; user-select:none;";
        
        const title = document.createElement('span');
        title.appendChild(document.createTextNode('Settings'));
        title.style.cssText = "font-size:16px; font-weight:600; color:#fff; font-family: sans-serif; opacity: 0.8;";
        
        const closeBtn = document.createElement('button');
        closeBtn.appendChild(document.createTextNode('x'));
        closeBtn.style.cssText = "width:32px; height:32px; border-radius:4px; border:none; background:transparent; color:#72767d; cursor:pointer; font-size:16px; display:flex; align-items:center; justify-content:center; transition: all 0.15s ease;";
        
        const closeOverlay = () => {
          overlay.style.opacity = '0';
          container.style.transform = 'scale(0.95)';
          window.removeEventListener('keydown', handleEsc);
          window.removeEventListener('message', handleMessage);
          setTimeout(() => overlay.remove(), 200);
        };

        const handleEsc = (e) => { if (e.key === 'Escape') closeOverlay(); };
        const handleMessage = (e) => { if (e.data === 'close-settings') closeOverlay(); };
        window.addEventListener('keydown', handleEsc);
        window.addEventListener('message', handleMessage);

        closeBtn.onmouseover = () => { 
          closeBtn.style.background = '#ed4245';
          closeBtn.style.color = '#fff'; 
        };
        closeBtn.onmouseout = () => { 
          closeBtn.style.background = 'transparent'; 
          closeBtn.style.color = '#72767d'; 
        };
        
        closeBtn.onclick = closeOverlay;
        overlay.onclick = (e) => { if (e.target === overlay) closeOverlay(); };
        
        const wv = document.createElement('webview');
        wv.setAttribute('partition', 'persist:llmtray');
        wv.style.cssText = 'flex: 1; width: 100%; height: 100%;';
        wv.src = 'file://${settingsViewPath}';
        wv.preload = 'file://${preloadPath}';
        
        header.appendChild(title);
        header.appendChild(closeBtn);
        container.appendChild(header);
        container.appendChild(wv);
        overlay.appendChild(container);
        document.body.appendChild(overlay);

        requestAnimationFrame(() => {
          overlay.style.opacity = '1';
          container.style.transform = 'scale(1)';
        });
      })();
    `);
    return true;
  } catch (e) {
    console.error("Settings overlay error:", e);
    return false;
  }
}

// -----------------------------------------------------------------------------
// IPC HANDLERS (Duplicates Removed)
// -----------------------------------------------------------------------------
handleTrustedIpc("get-settings", async () => loadSettings());

handleTrustedIpc("save-settings", async (_event, data) => {
  const prev = loadSettings();
  const next = { ...prev, ...sanitizeSettingsPatch(data) };
  saveSettings(next);
  registerShortcuts(next);
  enableAutoLaunch(!!next.autoLaunch);
  rebuildLLMs(next);
  rebuildSearchEngines(next);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("load-llm-list", LLM_URLS);
  }
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(getLLMTrayMenu()));
  return { success: true };
});

handleTrustedIpc("get-last-url", () => loadSettings().lastVisitedURL || null);
handleTrustedIpc("set-last-url", (_event, url) => {
  const safeUrl = sanitizeUrl(url);
  if (!safeUrl) return false;
  const s = loadSettings();
  s.lastVisitedURL = safeUrl;
  saveSettings(s);
  return true;
});

handleTrustedIpc("check-autostart", () => {
  if (isLinux())
    return fs.existsSync(
      path.join(os.homedir(), ".config/autostart/llm-tray.desktop"),
    );
  if (isWindows() || isMac()) return !!app.getLoginItemSettings().openAtLogin;
  return false;
});

handleTrustedIpc("refresh-tray", () => {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(getLLMTrayMenu()));
  return true;
});

handleTrustedIpc("open-settings-overlay", async () =>
  openSettingsOverlayInMainWindow(),
);

onTrustedIpc("force-focus-main", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.focus();
});

handleTrustedIpc("set-capture-mode", (_event, enabled) => {
  if (typeof enabled !== "boolean") return false;
  captureMode = enabled;
  if (captureMode) globalShortcut.unregisterAll();
  else registerShortcuts(loadSettings());
  return true;
});

handleTrustedIpc("load-llm", (_event, target) => {
  const safeTarget = sanitizeLLMTarget(target);
  if (!safeTarget) return false;
  openLLM(safeTarget);
  return true;
});
handleTrustedIpc("open-settings-tray", () => {
  openSettings();
  return true;
});

handleTrustedIpc("open-new-window", (_event, url) => {
  const safeUrl = sanitizeUrl(url);
  if (!safeUrl) return false;
  createLLMWindow(safeUrl);
  return true;
});

handleTrustedIpc("get-downloads-path", () => {
  return app.getPath("downloads");
});

handleTrustedIpc("get-download-tracker", () => {
  return getRecentDownloads(50);
});

handleTrustedIpc("open-downloads-folder", async () => {
  await shell.openPath(app.getPath("downloads"));
  return true;
});

handleTrustedIpc("open-download-item", async (_event, id) => {
  const safeId = sanitizeDownloadId(id);
  if (!safeId) return false;
  const rec = downloadRecords.get(safeId);
  if (!rec?.savePath) return false;
  shell.showItemInFolder(rec.savePath);
  return true;
});

handleTrustedIpc("cancel-download-item", async (_event, id) => {
  const safeId = sanitizeDownloadId(id);
  if (!safeId) return false;
  const item = activeDownloadItems.get(safeId);
  if (!item) return false;
  item.cancel();
  return true;
});

handleTrustedIpc("clear-finished-downloads", async () => {
  clearFinishedDownloads();
  return true;
});

handleTrustedIpc("set-zoom-level", (_event, level) => {
  const safeLevel = sanitizeNumber(level, { min: -5, max: 5 });
  if (safeLevel === null) return false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomLevel(safeLevel);
  }
  return true;
});

handleTrustedIpc("window-minimize", (event) => {
  const win = getEventWindow(event);
  if (!win) return false;
  win.minimize();
  return true;
});

handleTrustedIpc("window-toggle-maximize", (event) => {
  const win = getEventWindow(event);
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return true;
});

handleTrustedIpc("window-close", (event) => {
  const win = getEventWindow(event);
  if (!win) return false;
  win.close();
  return true;
});

handleTrustedIpc("get-window-maximized", (event) => {
  const win = getEventWindow(event);
  if (!win) return false;
  return win.isMaximized();
});

handleTrustedIpc("get-window-bounds", (event) => {
  const win = getEventWindow(event);
  if (!win) return null;
  const bounds = win.getBounds();
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
});

handleTrustedIpc("set-window-position", (event, payload) => {
  const win = getEventWindow(event);
  if (!win) return false;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  const x = sanitizeNumber(payload.x, { min: -100_000, max: 100_000, integer: true });
  const y = sanitizeNumber(payload.y, { min: -100_000, max: 100_000, integer: true });
  if (x === null || y === null) return false;

  if (win.isMaximized()) win.unmaximize();
  win.setPosition(x, y);
  return true;
});

handleTrustedIpc("set-window-opacity", (event, opacity) => {
  const win = getEventWindow(event);
  if (!win) return false;
  const safeOpacity = sanitizeNumber(opacity, { min: 0.2, max: 1 });
  if (safeOpacity === null) return false;
  try {
    win.setOpacity(safeOpacity);
    return true;
  } catch {
    return false;
  }
});

handleTrustedIpc("get-window-id", (event) => {
  const win = getEventWindow(event);
  return win ? win.id : null;
});

handleTrustedIpc("consume-tab-window-init", (event) => {
  const win = getEventWindow(event);
  if (!win) return null;
  const payload = pendingTabWindowInit.get(win.id) || null;
  pendingTabWindowInit.delete(win.id);
  return payload;
});

handleTrustedIpc("begin-tab-drag-session", (event, payload) => {
  const win = getEventWindow(event);
  if (!win) return false;
  const safe = sanitizeTabDragSession(payload);
  if (!safe || safe.sourceWindowId !== win.id) return false;
  activeTabDragSession = { ...safe, updatedAt: Date.now() };
  return true;
});

handleTrustedIpc("get-tab-drag-session", () => {
  if (!activeTabDragSession) return null;
  if (Date.now() - activeTabDragSession.updatedAt > 30000) {
    activeTabDragSession = null;
    return null;
  }
  return {
    sourceWindowId: activeTabDragSession.sourceWindowId,
    sourceTabId: activeTabDragSession.sourceTabId,
    kind: activeTabDragSession.kind,
    llmKey: activeTabDragSession.llmKey,
    url: activeTabDragSession.url,
  };
});

handleTrustedIpc("clear-tab-drag-session", (_event, payload) => {
  if (!activeTabDragSession) return true;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    activeTabDragSession = null;
    return true;
  }
  const sourceWindowId = sanitizeWindowId(payload.sourceWindowId);
  const sourceTabId = sanitizeString(payload.sourceTabId, 128);
  if (
    sourceWindowId &&
    activeTabDragSession.sourceWindowId !== sourceWindowId
  ) {
    return true;
  }
  if (sourceTabId && activeTabDragSession.sourceTabId !== sourceTabId) {
    return true;
  }
  activeTabDragSession = null;
  return true;
});

handleTrustedIpc("open-new-tab-window", (_event, tabData) => {
  const payload =
    tabData && typeof tabData === "object" && !Array.isArray(tabData) ? tabData : {};
  const safeUrl = sanitizeUrl(payload.url);
  if (!safeUrl) return false;
  const llmKey = sanitizeString(payload.llmKey, 64) || inferLLMKeyFromUrl(safeUrl) || "chatgpt";
  const promptText = sanitizePromptText(payload.promptText);
  const x = sanitizeNumber(payload.x, { min: -100_000, max: 100_000, integer: true });
  const y = sanitizeNumber(payload.y, { min: -100_000, max: 100_000, integer: true });
  const win = createTabHostWindow({ url: safeUrl, llmKey, promptText });
  if (!win) return false;
  if (x !== null && y !== null) {
    try {
      win.setPosition(x, y);
    } catch {}
  }
  return true;
});

handleTrustedIpc("complete-tab-transfer", (_event, payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const sourceWindowId = sanitizeWindowId(payload.sourceWindowId);
  const sourceTabId = sanitizeString(payload.sourceTabId, 128);
  if (!sourceWindowId || !sourceTabId) return false;
  if (
    activeTabDragSession &&
    activeTabDragSession.sourceWindowId === sourceWindowId &&
    activeTabDragSession.sourceTabId === sourceTabId
  ) {
    activeTabDragSession = null;
  }
  const sourceWin = BrowserWindow.fromId(sourceWindowId);
  if (!sourceWin || sourceWin.isDestroyed()) return false;
  sourceWin.webContents.send("tab-transfer-remove", sourceTabId);
  return true;
});

handleTrustedIpc("open-external", (_event, url) => {
  return openExternalSafe(url, { allowMailto: true });
});

// -----------------------------------------------------------------------------
// AUTO-LAUNCH Logic
// -----------------------------------------------------------------------------
function enableAutoLaunch(enabled) {
  if (isLinux()) {
    const autostartDir = path.join(os.homedir(), ".config/autostart");
    if (!fs.existsSync(autostartDir))
      fs.mkdirSync(autostartDir, { recursive: true });
    const desktopFile = path.join(autostartDir, "llm-tray.desktop");
    if (enabled) {
      const execPath =
        process.env.APPIMAGE ||
        (app.isPackaged
          ? app.getPath("exe")
          : `${process.execPath} ${path.join(__dirname, "main.js")}`);
      fs.writeFileSync(
        desktopFile,
        `[Desktop Entry]\nType=Application\nName=LLM Tray\nExec="${execPath}"\nX-GNOME-Autostart-enabled=true\nHidden=false\n`,
      );
    } else if (fs.existsSync(desktopFile)) fs.unlinkSync(desktopFile);
  } else if (isWindows() || isMac()) {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: app.getPath("exe"),
      args: [],
    });
  }
}

// -----------------------------------------------------------------------------
// NEW LLM WINDOW (Standalone)
// -----------------------------------------------------------------------------
function createLLMWindow(url, options = {}) {
  const safeUrl = sanitizeUrl(url);
  if (!safeUrl) return null;
  const promptText = sanitizePromptText(options.promptText);
  const st = loadSettings();
  const customUserAgent = sanitizeString(st.userAgent, 1024);
  const winW = parseInt(st.windowWidth) || 1200;
  const winH = parseInt(st.windowHeight) || 800;

  const llmWindow = new BrowserWindow({
    width: winW,
    height: winH,
    icon: getTrayIcon(),
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload-guest.js"),
      contextIsolation: true,
      nodeIntegration: false,
      safeDialogs: true,
      webviewTag: true,
      spellcheck: true,
      ...(customUserAgent ? { userAgent: customUserAgent } : {}),
    },
  });

  trackDownloadForSession(llmWindow.webContents.session);

  if (st.zoomLevel) {
    llmWindow.webContents.setZoomLevel(st.zoomLevel);
  }

  llmWindow.loadURL(safeUrl);
  if (promptText) {
    llmWindow.webContents.once("did-finish-load", () => {
      seedPromptInWebContents(llmWindow.webContents, promptText);
    });
  }

  // Apply same navigation restrictions
  llmWindow.webContents.on("will-navigate", (e, navUrl) => {
    if (isAllowedInAppNavigation(navUrl)) return;
    const currentURL = llmWindow.webContents.getURL();
    if (navUrl.split("#")[0] === currentURL.split("#")[0]) return;
    e.preventDefault();
    openExternalSafe(navUrl);
  });

  llmWindow.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    if (isAllowedPopupUrl(popupUrl)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 480,
          height: 640,
          parent: llmWindow,
          modal: true,
        },
      };
    }
    return { action: "deny" };
  });

  return llmWindow;
}

function createTabHostWindow(initialTab = null) {
  const st = loadSettings();
  const customUserAgent = sanitizeString(st.userAgent, 1024);
  if (!st.enableTabs) {
    const fallbackUrl = sanitizeUrl(initialTab?.url);
    return fallbackUrl
      ? createLLMWindow(fallbackUrl, { promptText: initialTab?.promptText })
      : null;
  }

  const winW = parseInt(st.windowWidth) || 1200;
  const winH = parseInt(st.windowHeight) || 800;
  const useChromelessTabs = st.hideSystemBorders === true;
  const initialUrl = sanitizeUrl(initialTab?.url);
  const initialKey = sanitizeString(initialTab?.llmKey, 64) || "chatgpt";
  const initialPrompt = sanitizePromptText(initialTab?.promptText);

  const tabWindow = new BrowserWindow({
    width: winW,
    height: winH,
    icon: getTrayIcon(),
    frame: !useChromelessTabs,
    titleBarStyle: useChromelessTabs ? "hidden" : "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      safeDialogs: true,
      webviewTag: true,
      spellcheck: true,
      ...(customUserAgent ? { userAgent: customUserAgent } : {}),
    },
  });

  if (initialUrl) {
    const payload = { url: initialUrl, llmKey: initialKey };
    if (initialPrompt) payload.promptText = initialPrompt;
    pendingTabWindowInit.set(tabWindow.id, payload);
  }
  tabWindow.on("closed", () => {
    pendingTabWindowInit.delete(tabWindow.id);
  });

  trackDownloadForSession(tabWindow.webContents.session);
  tabWindow.setContentProtection(true);

  if (st.zoomLevel) {
    tabWindow.webContents.setZoomLevel(st.zoomLevel);
  }

  tabWindow.on("resize", () => {
    const [w, h] = tabWindow.getSize();
    const s = loadSettings();
    s.windowWidth = w;
    s.windowHeight = h;
    saveSettings(s);
  });

  const sendWindowState = () => {
    if (!tabWindow || tabWindow.isDestroyed()) return;
    tabWindow.webContents.send("window-maximized", tabWindow.isMaximized());
  };
  tabWindow.on("maximize", sendWindowState);
  tabWindow.on("unmaximize", sendWindowState);

  tabWindow.webContents.on("context-menu", (event, params) => {
    event.preventDefault();
    showRichContextMenu(tabWindow.webContents, params, {
      isTabWebview: false,
      hostWindow: tabWindow,
    });
  });

  tabWindow.webContents.on("did-attach-webview", (_event, webviewContents) => {
    trackDownloadForSession(webviewContents.session);
    webviewContents.on("context-menu", (event, params) => {
      event.preventDefault();
      showRichContextMenu(webviewContents, params, {
        isTabWebview: true,
        hostWindow: tabWindow,
      });
    });
  });

  tabWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedPopupUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 480,
          height: 640,
          parent: tabWindow,
          modal: true,
        },
      };
    }
    return { action: "deny" };
  });

  rebuildLLMs(st);
  rebuildSearchEngines(st);

  tabWindow.loadFile(path.join(__dirname, "views", "index.html"));
  tabWindow.webContents.once("did-finish-load", () => {
    tabWindow.webContents.send("load-llm-list", LLM_URLS);
    sendWindowState();
  });

  return tabWindow;
}

// -----------------------------------------------------------------------------
// MAIN WINDOW Creation (With Tab Support)
// -----------------------------------------------------------------------------
function createMainWindow() {
  const st = loadSettings();
  const customUserAgent = sanitizeString(st.userAgent, 1024);
  const winW = parseInt(st.windowWidth) || 1200;
  const winH = parseInt(st.windowHeight) || 800;
  const preloadFile = st.enableTabs ? "preload.js" : "preload-guest.js";
  const useChromelessTabs = !!st.enableTabs && st.hideSystemBorders === true;

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    show: false,
    icon: getTrayIcon(),
    frame: !useChromelessTabs,
    titleBarStyle: useChromelessTabs ? "hidden" : "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, preloadFile),
      contextIsolation: true,
      nodeIntegration: false,
      safeDialogs: true,
      webviewTag: true,
      spellcheck: true,
      ...(customUserAgent ? { userAgent: customUserAgent } : {}),
    },
  });

  trackDownloadForSession(mainWindow.webContents.session);

  mainWindow.setContentProtection(true);

  const sendWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("window-maximized", mainWindow.isMaximized());
  };
  mainWindow.on("maximize", sendWindowState);
  mainWindow.on("unmaximize", sendWindowState);

  // Apply zoom level from settings
  if (st.zoomLevel) {
    mainWindow.webContents.setZoomLevel(st.zoomLevel);
  }

  mainWindow.on("resize", () => {
    const [w, h] = mainWindow.getSize();
    const s = loadSettings();
    s.windowWidth = w;
    s.windowHeight = h;
    saveSettings(s);
  });

  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.on("page-title-updated", (_e, title) => {
    const m = title.match(/\((\d+)\)/);
    unreadBadges[activeLLMKey] = m ? parseInt(m[1], 10) : 0;
    if (tray) tray.setContextMenu(Menu.buildFromTemplate(getLLMTrayMenu()));
  });

  const persistLastVisitedURL = (_event, url) => {
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) return;
    const s = loadSettings();
    s.lastVisitedURL = safeUrl;
    const inferred = inferLLMKeyFromUrl(safeUrl);
    if (inferred) {
      s.activeLLMKey = inferred;
      activeLLMKey = inferred;
    }
    saveSettings(s);
  };

  mainWindow.webContents.on("did-navigate", persistLastVisitedURL);
  mainWindow.webContents.on("did-navigate-in-page", persistLastVisitedURL);

  // INTERCEPT GROK OAUTH BEFORE IT GOES EXTERNAL
  mainWindow.webContents.on("will-redirect", (event, url) => {
    console.log("[Will-Redirect]", url);
    const parsed = parseHttpURL(url);
    const host = parsed?.hostname?.toLowerCase() || "";
    const pathname = parsed?.pathname?.toLowerCase() || "";
    if (
      hostnameMatches(host, "grok.com") &&
      AUTH_PATH_HINTS.some((hint) => pathname.includes(hint))
    ) {
      console.log("[Grok OAuth] Captured redirect, staying in-app");
      // Don't prevent - let it load in-app
      return;
    }
  });

  mainWindow.webContents.on("will-navigate", (e, url) => {
    console.log("[Will-Navigate]", url);

    if (isAllowedInAppNavigation(url)) return;

    const currentURL = mainWindow.webContents.getURL();

    // 1. Allow if it's just an anchor/fragment change (Carousel navigation)
    if (url.split("#")[0] === currentURL.split("#")[0]) {
      return;
    }

    e.preventDefault();
    openExternalSafe(url);
  });
  mainWindow.webContents.on("context-menu", (event, params) => {
    event.preventDefault();
    showRichContextMenu(mainWindow.webContents, params, {
      isTabWebview: false,
      hostWindow: mainWindow,
    });
  });

  mainWindow.webContents.on("did-attach-webview", (_event, webviewContents) => {
    trackDownloadForSession(webviewContents.session);
    webviewContents.on("context-menu", (event, params) => {
      event.preventDefault();
      showRichContextMenu(webviewContents, params, {
        isTabWebview: true,
        hostWindow: mainWindow,
      });
    });
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log("[Window-Open]", url);

    if (isAllowedPopupUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 480,
          height: 640,
          parent: mainWindow,
          modal: true,
        },
      };
    }
    return { action: "deny" };
  });

  const s = loadSettings();
  rebuildLLMs(s);
  rebuildSearchEngines(s);

  // Choose between tab mode or single view mode
  if (s.enableTabs) {
    // Load the tab interface
    mainWindow.loadFile(path.join(__dirname, "views", "index.html"));

    mainWindow.webContents.once("did-finish-load", () => {
      // Send LLM list to renderer for the "+" menu
      mainWindow.webContents.send("load-llm-list", LLM_URLS);
      sendWindowState();
    });
  } else {
    // Traditional single-view mode (default)
    const requestedKey = s.activeLLMKey || s.defaultLLM?.toLowerCase();
    const fallbackKey =
      requestedKey && LLM_URLS[requestedKey] ? requestedKey : LLM_KEYS[0];
    activeLLMKey = fallbackKey || "chatgpt";
    const startURL = s.lastVisitedURL || LLM_URLS[activeLLMKey] || BASE_LLMS.chatgpt;
    mainWindow.loadURL(startURL);
  }

  mainWindow.once("ready-to-show", () => {
    if (s.showOnStartup !== false) mainWindow.show();
    registerShortcuts(s);
  });
}

function rebuildSearchEngines(settings) {
  const hidden = new Set(settings.searchEnginesHidden || []);
  const custom = (settings.customSearchEngines || []).reduce((acc, c) => {
    if (c.visible !== false) acc[c.name.toLowerCase()] = c.template;
    return acc;
  }, {});
  SEARCH_ENGINES = Object.fromEntries(
    Object.entries({ ...BASE_SEARCH_ENGINES, ...custom }).filter(
      ([name]) => !hidden.has(name),
    ),
  );
}

function rebuildLLMs(settings) {
  const hidden = new Set(settings.hiddenLLMs || []);

  // Create the default pool
  const baseItems = Object.entries(BASE_LLMS).map(([name, url]) => ({
    name,
    url,
  }));
  const customItems = (settings.customLLMs || []).map((c) => ({
    name: c.name,
    url: c.url,
  }));

  // Use orderedLLMs only when it contains entries; empty arrays should fall back.
  const ordered = Array.isArray(settings.orderedLLMs) ? settings.orderedLLMs : [];
  const sourceList = ordered.length > 0 ? ordered : [...baseItems, ...customItems];

  LLM_URLS = {};
  sourceList.forEach((item) => {
    if (!item || typeof item.name !== "string" || typeof item.url !== "string")
      return;
    const key = item.name.trim().toLowerCase();
    const safeUrl = sanitizeUrl(item.url);
    if (!key || !safeUrl || hidden.has(key)) return;
    LLM_URLS[key] = safeUrl;
  });

  // Never allow an empty set at startup; it causes a blank/no-LLM boot.
  if (Object.keys(LLM_URLS).length === 0) {
    LLM_URLS = { ...BASE_LLMS };
  }

  LLM_KEYS = Object.keys(LLM_URLS);
}

function openLLM(keyOrUrl) {
  if (!mainWindow) return;
  const url = LLM_URLS[keyOrUrl] || sanitizeUrl(keyOrUrl);
  if (!url) {
    console.error("[openLLM] No URL resolved for:", keyOrUrl);
    return;
  }

  // Set the key explicitly if it exists in our list, otherwise try to find it
  if (LLM_URLS[keyOrUrl]) {
    activeLLMKey = keyOrUrl;
  } else {
    activeLLMKey = LLM_KEYS.find((k) => LLM_URLS[k] === url) || activeLLMKey;
  }

  mainWindow.loadURL(url);

  // Save both the URL and the specific KEY to settings
  const s = loadSettings();
  s.lastVisitedURL = url;
  s.activeLLMKey = activeLLMKey;
  saveSettings(s);

  // Rebuild the menu to refresh the checkmark immediately
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(getLLMTrayMenu()));
}

function getLLMTrayMenu() {
  return [
    { label: "Show/Hide", click: toggleWindow },
    { label: "Center Window", click: centerWindow },
    { type: "separator" },
    { label: "Settings", click: openSettings },

    { type: "separator" },
    ...LLM_KEYS.map((key) => ({
      label:
        key === activeLLMKey
          ? `✓ ${key.charAt(0).toUpperCase() + key.slice(1)}`
          : key.charAt(0).toUpperCase() + key.slice(1),
      click: () => openLLM(key),
    })),
    { type: "separator" },
    { label: "Quit", role: "quit" },
  ];
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function centerWindow() {
  const { screen } = require("electron");
  const winBounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(winBounds);
  const { x, y, width, height } = display.workArea;
  mainWindow.setPosition(
    Math.round(x + (width - winBounds.width) / 2),
    Math.round(y + (height - winBounds.height) / 2),
  );
  mainWindow.show();
}

function openSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.show();
  mainWindow.focus();
  openSettingsOverlayInMainWindow();
}

function registerShortcuts(settings) {
  try {
    globalShortcut.unregisterAll();
    if (captureMode) return;
    const combo = settings.shortcut || "Ctrl+Shift+Space";
    globalShortcut.register(combo, toggleWindow);
    if (settings.centerShortcut)
      globalShortcut.register(settings.centerShortcut, centerWindow);
    if (settings.settingsShortcut)
      globalShortcut.register(settings.settingsShortcut, openSettings);
  } catch (e) {
    console.error("Error registering shortcut:", e);
  }
}

app.on("before-quit", () => (isQuitting = true));
app.on("will-quit", () => globalShortcut.unregisterAll());

app.whenReady().then(() => {
  trackDownloadForSession(session.defaultSession);
  trackDownloadForSession(session.fromPartition("persist:llmtray"));

  // Force protocol registration on Linux
  if (isLinux() && app.isPackaged) {
    const desktopFile = path.join(
      os.homedir(),
      ".local/share/applications/llm-tray.desktop",
    );

    const execPath = process.env.APPIMAGE || app.getPath("exe");

    const desktopContent = `[Desktop Entry]
Type=Application
Name=LLM Tray
Exec="${execPath}" %u
Icon=llm-tray
MimeType=x-scheme-handler/llmtray;
NoDisplay=true
Terminal=false
`;

    const dir = path.dirname(desktopFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(desktopFile, desktopContent);

    // Update MIME database
    const { exec } = require("child_process");
    exec("update-desktop-database ~/.local/share/applications", (err) => {
      if (err) console.error("Failed to update desktop database:", err);
    });
    exec(
      "xdg-mime default llm-tray.desktop x-scheme-handler/llmtray",
      (err) => {
        if (err) console.error("Failed to set default handler:", err);
      },
    );
  }

  const s = loadSettings();
  rebuildLLMs(s);
  rebuildSearchEngines(s);
  createMainWindow();
  createTray();
  registerShortcuts(s);
});

function createTray() {
  tray = new Tray(getTrayIcon());
  tray.setToolTip(isDevMode ? "LLM Tray (Dev)" : "LLM Tray");
  tray.setContextMenu(Menu.buildFromTemplate(getLLMTrayMenu()));
  tray.on("click", () => toggleWindow());
}
