import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@t3tools/contracts";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const BROWSER_ATTACH_CHANNEL = "desktop:browser-attach";
const BROWSER_SET_VISIBLE_CHANNEL = "desktop:browser-set-visible";
const BROWSER_NAVIGATE_CHANNEL = "desktop:browser-navigate";
const BROWSER_GO_BACK_CHANNEL = "desktop:browser-go-back";
const BROWSER_GO_FORWARD_CHANNEL = "desktop:browser-go-forward";
const BROWSER_RELOAD_CHANNEL = "desktop:browser-reload";
const BROWSER_GET_STATE_CHANNEL = "desktop:browser-get-state";
const BROWSER_OBSERVE_CHANNEL = "desktop:browser-observe";
const BROWSER_ACT_CHANNEL = "desktop:browser-act";
const BROWSER_EXTRACT_CHANNEL = "desktop:browser-extract";
const BROWSER_WAIT_CHANNEL = "desktop:browser-wait";
const BROWSER_STATE_CHANNEL = "desktop:browser-state";
const wsUrl = process.env.T3CODE_DESKTOP_WS_URL ?? null;

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => wsUrl,
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  browserAttach: (threadId) => ipcRenderer.invoke(BROWSER_ATTACH_CHANNEL, threadId),
  browserSetVisible: (threadId, visible, bounds) =>
    ipcRenderer.invoke(BROWSER_SET_VISIBLE_CHANNEL, threadId, visible, bounds),
  browserNavigate: (threadId, url) => ipcRenderer.invoke(BROWSER_NAVIGATE_CHANNEL, threadId, url),
  browserGoBack: (threadId) => ipcRenderer.invoke(BROWSER_GO_BACK_CHANNEL, threadId),
  browserGoForward: (threadId) => ipcRenderer.invoke(BROWSER_GO_FORWARD_CHANNEL, threadId),
  browserReload: (threadId) => ipcRenderer.invoke(BROWSER_RELOAD_CHANNEL, threadId),
  browserGetState: (threadId) => ipcRenderer.invoke(BROWSER_GET_STATE_CHANNEL, threadId),
  browserObserve: (threadId, target) => ipcRenderer.invoke(BROWSER_OBSERVE_CHANNEL, threadId, target),
  browserAct: (threadId, action) => ipcRenderer.invoke(BROWSER_ACT_CHANNEL, threadId, action),
  browserExtract: (threadId, query) => ipcRenderer.invoke(BROWSER_EXTRACT_CHANNEL, threadId, query),
  browserWait: (threadId, durationMs) => ipcRenderer.invoke(BROWSER_WAIT_CHANNEL, threadId, durationMs),
  onBrowserState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(BROWSER_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(BROWSER_STATE_CHANNEL, wrappedListener);
    };
  },
} satisfies DesktopBridge);
