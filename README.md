# LLM Tray

Tray-first desktop launcher for multiple LLM web apps, built with Electron.

LLM Tray keeps ChatGPT, Gemini, Claude, Grok (plus custom providers) one hotkey away with optional tabbed browsing, fast switching, and a focused settings panel.

This repo is mainly an experiment in whether a usable app can be built almost entirely through vibe coding, with only light manual editing.

## Features

- Tray app with quick `Show/Hide`, `Center Window`, provider switching, and `Quit`
- Configurable global hotkeys (toggle window, center window, open settings)
- Single-view mode or tabbed mode for multi-tab browsing
- Built-in providers: ChatGPT, Gemini, Claude, Grok
- Custom LLMs: add, remove, reorder, and hide providers
- Rich context menu inside web content:
  - Search selected text with configurable search engines
  - Open selected text in a chosen LLM
  - Download media
  - Open links/chats externally
- Download tracker panel (recent downloads, cancel active, clear finished, open folder)
- Startup and behavior settings:
  - Launch at login
  - Show on startup
  - Zoom level
  - Optional user-agent override
  - Optional chromeless window controls in tab mode

## Quick Start

### Requirements

- Node.js 18+ recommended
- npm

### Install and run

```bash
npm install
npm run start
```

## Build

Create distributables with:

```bash
npm run dist
```

Current builder targets:

- Windows: NSIS installer
- Linux: AppImage

Build output is written to `dist/`.

## Default Providers and Search Engines

### LLMs

- ChatGPT: `https://chatgpt.com/`
- Gemini: `https://gemini.google.com/`
- Claude: `https://claude.ai/`
- Grok: `https://grok.com/`

### Search Engines

- Google
- DuckDuckGo
- Bing
- Brave Search
- Kagi

Custom search engines are supported via URL templates that include `%s`.

## Settings and Data

- App settings are stored in Electron `userData` as `settings.json`
- Downloads are saved to your OS downloads folder
- Linux autostart uses `~/.config/autostart/llm-tray.desktop`

## Project Structure

- `main.js`: app lifecycle, tray, windows, IPC, downloads, shortcuts
- `preload.js`: secure renderer API bridge for tab host/settings
- `preload-guest.js`: secure preload for standalone LLM windows
- `views/index.html` + `views/tabs.js`: tab UI and tab behaviors
- `views/settings.html`: settings interface

## Notes

- Tab mode and borderless tab mode changes require app restart.
- External navigation is restricted; unsupported domains open in your default browser.

## License

GPL-3.0 (see LICENSE).
