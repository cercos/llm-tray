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

function isAllowedDrag(e) {
  const dt = e.dataTransfer;
  if (!dt || !dt.types) return false;
  const types = Array.from(dt.types);
  return (
    types.includes("Files") ||
    types.includes("text/html") ||
    types.some((t) => t.includes("image"))
  );
}

function dragGate(e) {
  if (isAllowedDrag(e)) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    e.dataTransfer.dropEffect = "none";
    e.dataTransfer.effectAllowed = "none";
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

window.addEventListener("auxclick", (e) => {
  if (e.button === 1) openLinkExternally(e);
});

window.addEventListener("click", (e) => {
  if (e.ctrlKey || e.metaKey) openLinkExternally(e);
});

window.addEventListener("pointerdown", () => notifyHost("guest-pointerdown"), true);
window.addEventListener("contextmenu", () => notifyHost("guest-contextmenu"), true);

["dragenter", "dragover"].forEach((type) => {
  window.addEventListener(type, dragGate, true);
});

window.addEventListener("DOMContentLoaded", () => {
  const kickstart = () => {
    window.dispatchEvent(new Event("resize"));
  };

  setTimeout(kickstart, 350);
  setTimeout(kickstart, 1200);
});

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
      if (scroller) return { target: document.activeElement, scroller };
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
