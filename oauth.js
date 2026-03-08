const { BrowserWindow } = require("electron");
const { URL } = require("url");

let oauthWindow = null;

function startOAuthFlow(callbackUrl) {
  console.log("[OAuth] Received callback:", callbackUrl);

  try {
    const parsed = new URL(callbackUrl);

    // Extract auth parameters (adjust based on Grok's actual callback format)
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    const token = parsed.searchParams.get("token");

    console.log("[OAuth] Parsed params:", { code, state, token });

    // Close OAuth window if still open
    if (oauthWindow && !oauthWindow.isDestroyed()) {
      oauthWindow.close();
      oauthWindow = null;
    }

    // If you need to inject auth into main window:
    const mainWindow = require("./main.js").mainWindow;
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Store auth token or trigger login completion
      mainWindow.webContents.executeJavaScript(`
        console.log('OAuth callback received');
        // Grok-specific auth completion logic here
      `);
      mainWindow.show();
      mainWindow.focus();
    }

    return true;
  } catch (err) {
    console.error("[OAuth] Callback parsing failed:", err);
    return false;
  }
}

function createOAuthWindow(authUrl) {
  if (oauthWindow && !oauthWindow.isDestroyed()) {
    oauthWindow.focus();
    return;
  }

  oauthWindow = new BrowserWindow({
    width: 500,
    height: 700,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  oauthWindow.loadURL(authUrl);

  oauthWindow.on("closed", () => {
    oauthWindow = null;
  });

  // Intercept redirects to llmtray://
  oauthWindow.webContents.on("will-redirect", (event, url) => {
    if (url.startsWith("llmtray://")) {
      event.preventDefault();
      startOAuthFlow(url);
    }
  });
}

module.exports = { startOAuthFlow, createOAuthWindow };
