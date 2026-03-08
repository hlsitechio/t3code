import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Http from "node:http";
import * as OS from "node:os";
import { runFirstRunBootstrap } from "./bootstrapDeps";
import * as Path from "node:path";

import {
  app,
  BrowserView,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  shell,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import * as Effect from "effect/Effect";
import type {
  DesktopBrowserActInput,
  DesktopBrowserActionResult,
  DesktopBrowserExtractResult,
  DesktopBrowserObserveResult,
  DesktopBrowserViewBounds,
  DesktopBrowserViewState,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";
import { autoUpdater } from "electron-updater";

import type { ContextMenuItem } from "@t3tools/contracts";
import { NetService } from "@t3tools/shared/Net";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { showDesktopConfirmDialog } from "./confirmDialog";
import { fixPath } from "./fixPath";
import {
  getAutoUpdateDisabledReason,
  shouldBroadcastDownloadProgress,
} from "./updateState";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";
import { captureBrowserViewScreenshot } from "./browserCdp";
import { actOnBrowserView, extractBrowserView, observeBrowserView } from "./browserOperator";

fixPath();

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
const STATE_DIR =
  process.env.T3CODE_STATE_DIR?.trim() || Path.join(OS.homedir(), ".t3", "userdata");
const DESKTOP_SCHEME = "t3";
const ROOT_DIR = Path.resolve(__dirname, "../../..");
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_DISPLAY_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
const APP_USER_MODEL_ID = "com.t3tools.t3code";
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LOG_DIR = Path.join(STATE_DIR, "logs");
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DESKTOP_UPDATE_CHANNEL = "latest";
const DESKTOP_UPDATE_ALLOW_PRERELEASE = false;
const DESKTOP_OPERATOR_HOST = "127.0.0.1";
const DESKTOP_OPERATOR_PATH = "/lab-browser-operator";
const OPEN_DEVTOOLS_IN_DEV = process.env.T3CODE_OPEN_DEVTOOLS === "1";

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess.ChildProcess | null = null;
let backendPort = 0;
let backendAuthToken = "";
let backendWsUrl = "";
let restartAttempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache: string | null | undefined;
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;
const initialUpdateState = (): DesktopUpdateState => createInitialDesktopUpdateState(app.getVersion());

function logTimestamp(): string {
  return new Date().toISOString();
}

function logScope(scope: string): string {
  return `${scope} run=${APP_RUN_ID}`;
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function writeDesktopLogHeader(message: string): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}

function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
  );
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

function installStdIoCapture(): void {
  if (!app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) {
    return;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const patchWrite =
    (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      writeDesktopStreamChunk(streamName, chunk, encoding);
      if (typeof encodingOrCallback === "function") {
        return originalWrite(chunk, encodingOrCallback);
      }
      if (callback !== undefined) {
        return originalWrite(chunk, encoding, callback);
      }
      if (encoding !== undefined) {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk);
    };

  process.stdout.write = patchWrite("stdout", originalStdoutWrite);
  process.stderr.write = patchWrite("stderr", originalStderrWrite);

  restoreStdIoCapture = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    restoreStdIoCapture = null;
  };
}

function initializePackagedLogging(): void {
  if (!app.isPackaged) return;
  try {
    desktopLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "desktop-main.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    backendLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, "server-child.log"),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
    });
    installStdIoCapture();
    writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
  }
}

function captureBackendOutput(child: ChildProcess.ChildProcess): void {
  if (!app.isPackaged || backendLogSink === null) return;
  const writeChunk = (chunk: unknown): void => {
    if (!backendLogSink) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    backendLogSink.write(buffer);
  };
  child.stdout?.on("data", writeChunk);
  child.stderr?.on("data", writeChunk);
}

initializePackagedLogging();

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
let updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let updaterConfigured = false;
let updateState: DesktopUpdateState = initialUpdateState();
let activeBrowserThreadId: string | null = null;
let operatorApiServer: Http.Server | null = null;
let operatorApiUrl = "";
let operatorApiToken = "";

type DesktopBrowserSession = {
  threadId: string;
  view: BrowserView;
  bounds: DesktopBrowserViewBounds;
  isVisible: boolean;
  state: DesktopBrowserViewState;
};

const browserSessions = new Map<string, DesktopBrowserSession>();

interface DesktopOperatorObserveResponse {
  state: DesktopBrowserViewState;
  observation: DesktopBrowserObserveResult;
  screenshotBase64: string | null;
}

interface DesktopOperatorExtractResponse {
  state: DesktopBrowserViewState;
  extraction: DesktopBrowserExtractResult;
}

type DesktopOperatorRpcResult =
  | DesktopBrowserViewState
  | DesktopBrowserActionResult
  | DesktopOperatorObserveResponse
  | DesktopOperatorExtractResponse;

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return updateState.errorContext;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function resolveAppRoot(): string {
  if (!app.isPackaged) {
    return ROOT_DIR;
  }
  return app.getAppPath();
}

/** Read the baked-in app-update.yml config (if applicable). */
function readAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}

function resolveEmbeddedCommitHash(): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { t3codeCommitHash?: unknown };
    return normalizeCommitHash(parsed.t3codeCommitHash);
  } catch {
    return null;
  }
}

function resolveAboutCommitHash(): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(process.env.T3CODE_COMMIT_HASH);
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash();

  return aboutCommitHashCache;
}

function resolveBackendEntry(): string {
  return Path.join(resolveAppRoot(), "apps/server/dist/index.mjs");
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot();
  }
  return OS.homedir();
}

function resolveDesktopStaticDir(): string | null {
  const appRoot = resolveAppRoot();
  const candidates = [
    Path.join(appRoot, "apps/server/dist/client"),
    Path.join(appRoot, "apps/web/dist"),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

function resolveDesktopStaticPath(staticRoot: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  const rawPath = decodeURIComponent(url.pathname);
  const normalizedPath = Path.posix.normalize(rawPath).replace(/^\/+/, "");
  if (normalizedPath.includes("..")) {
    return Path.join(staticRoot, "index.html");
  }

  const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
  const resolvedPath = Path.join(staticRoot, requestedPath);

  if (Path.extname(resolvedPath)) {
    return resolvedPath;
  }

  const nestedIndex = Path.join(resolvedPath, "index.html");
  if (FS.existsSync(nestedIndex)) {
    return nestedIndex;
  }

  return Path.join(staticRoot, "index.html");
}

function isStaticAssetRequest(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return Path.extname(url.pathname).length > 0;
  } catch {
    return false;
  }
}

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox("T3 Code failed to start", `Stage: ${stage}\n${message}${detail}`);
  }
  stopBackend();
  restoreStdIoCapture?.();
  app.quit();
}

function registerDesktopProtocol(): void {
  if (isDevelopment || desktopProtocolRegistered) return;

  const staticRoot = resolveDesktopStaticDir();
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    try {
      const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      const isAssetRequest = isStaticAssetRequest(request.url);

      if (!isInRoot || !FS.existsSync(resolvedCandidate)) {
        if (isAssetRequest) {
          callback({ error: -6 });
          return;
        }
        callback({ path: fallbackIndex });
        return;
      }

      callback({ path: resolvedCandidate });
    } catch {
      callback({ path: fallbackIndex });
    }
  });

  desktopProtocolRegistered = true;
}

function dispatchMenuAction(action: string): void {
  const existingWindow =
    BrowserWindow.getFocusedWindow() ?? mainWindow ?? BrowserWindow.getAllWindows()[0];
  const targetWindow = existingWindow ?? createWindow();
  if (!existingWindow) {
    mainWindow = targetWindow;
  }

  const send = () => {
    if (targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(MENU_ACTION_CHANNEL, action);
    if (!targetWindow.isVisible()) {
      targetWindow.show();
    }
    targetWindow.focus();
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function handleCheckForUpdatesMenuClick(): void {
  const disabledReason = getAutoUpdateDisabledReason({
    isDevelopment,
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
  });
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason,
      buttons: ["OK"],
    });
    return;
  }

  if (!BrowserWindow.getAllWindows().length) {
    mainWindow = createWindow();
  }
  void checkForUpdates("menu");
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchMenuAction("open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        ...(process.platform === "darwin"
          ? []
          : [
              {
                label: "Settings...",
                accelerator: "CmdOrCtrl+,",
                click: () => dispatchMenuAction("open-settings"),
              },
              { type: "separator" as const },
            ]),
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
      ],
    },
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveResourcePath(fileName: string): string | null {
  const candidates = [
    Path.join(__dirname, "../resources", fileName),
    Path.join(process.resourcesPath, "resources", fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveIconPath(ext: "ico" | "icns" | "png"): string | null {
  return resolveResourcePath(`icon.${ext}`);
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }

  if (process.platform === "darwin" && app.dock) {
    const iconPath = resolveIconPath("png");
    if (iconPath) {
      app.dock.setIcon(iconPath);
    }
  }
}

function clearUpdatePollTimer(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(UPDATE_STATE_CHANNEL, updateState);
  }
}

function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  updateState = { ...updateState, ...patch };
  emitUpdateState();
}

function shouldEnableAutoUpdates(): boolean {
  return (
    getAutoUpdateDisabledReason({
      isDevelopment,
      isPackaged: app.isPackaged,
      platform: process.platform,
      appImage: process.env.APPIMAGE,
      disabledByEnv: process.env.T3CODE_DISABLE_AUTO_UPDATE === "1",
    }) === null
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeBrowserBounds(bounds: DesktopBrowserViewBounds | undefined): DesktopBrowserViewBounds {
  if (!bounds) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: Math.max(0, Math.floor(bounds.x)),
    y: Math.max(0, Math.floor(bounds.y)),
    width: Math.max(0, Math.floor(bounds.width)),
    height: Math.max(0, Math.floor(bounds.height)),
  };
}

function normalizeBrowserUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new Error("Browser URL cannot be empty.");
  }
  if (/\s/.test(trimmed)) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
  }
  if (
    !trimmed.includes("://") &&
    !trimmed.includes(".") &&
    trimmed !== "localhost" &&
    !/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)
  ) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
  }
  const withProtocol =
    trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  return parsed.toString();
}

function isRecoverableBrowserLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  return (
    code === "ERR_ABORTED" ||
    code === "ERR_NAME_NOT_RESOLVED" ||
    code === "ERR_INTERNET_DISCONNECTED" ||
    code === "ERR_CONNECTION_REFUSED" ||
    code === "ERR_CONNECTION_TIMED_OUT"
  );
}

function createEmptyBrowserState(threadId: string): DesktopBrowserViewState {
  return {
    threadId,
    url: null,
    title: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isVisible: false,
    lastUpdatedAt: nowIso(),
  };
}

function emitBrowserState(state: DesktopBrowserViewState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(BROWSER_STATE_CHANNEL, state);
  }
}

function readBrowserState(session: DesktopBrowserSession): DesktopBrowserViewState {
  const webContents = session.view.webContents;
  if (webContents.isDestroyed()) {
    return {
      threadId: session.threadId,
      url: session.state.url,
      title: session.state.title,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isVisible: session.isVisible,
      lastUpdatedAt: nowIso(),
    };
  }
  const url = webContents.getURL();
  const title = webContents.getTitle();
  return {
    threadId: session.threadId,
    url: url.length > 0 ? url : null,
    title: title.length > 0 ? title : null,
    loading: webContents.isLoading(),
    canGoBack: webContents.navigationHistory.canGoBack(),
    canGoForward: webContents.navigationHistory.canGoForward(),
    isVisible: session.isVisible,
    lastUpdatedAt: nowIso(),
  };
}

function updateBrowserSessionState(session: DesktopBrowserSession): DesktopBrowserViewState {
  const nextState = readBrowserState(session);
  session.state = nextState;
  emitBrowserState(nextState);
  return nextState;
}

function attachBrowserSessionToWindow(threadId: string | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    activeBrowserThreadId = threadId;
    return;
  }

  if (activeBrowserThreadId === threadId && threadId !== null) {
    const activeSession = browserSessions.get(threadId);
    if (activeSession && !activeSession.view.webContents.isDestroyed()) {
      updateBrowserSessionState(activeSession);
      return;
    }
  }

  const currentSession =
    activeBrowserThreadId !== null ? browserSessions.get(activeBrowserThreadId) : undefined;
  if (currentSession && !currentSession.view.webContents.isDestroyed()) {
    try {
      mainWindow.removeBrowserView(currentSession.view);
    } catch {
      // ignore stale detach failures
    }
  }

  activeBrowserThreadId = threadId;
  if (threadId === null) {
    return;
  }

  const nextSession = browserSessions.get(threadId);
  if (!nextSession) {
    return;
  }
  if (nextSession.view.webContents.isDestroyed()) {
    browserSessions.delete(threadId);
    return;
  }

  mainWindow.addBrowserView(nextSession.view);
  const { x, y, width, height } = nextSession.bounds;
  nextSession.view.setBounds({ x, y, width, height });
  nextSession.view.setAutoResize({ width: false, height: false });
  updateBrowserSessionState(nextSession);
}

function ensureBrowserSession(threadId: string): DesktopBrowserSession {
  const existing = browserSessions.get(threadId);
  if (existing) {
    return existing;
  }

  const view = new BrowserView({
    webPreferences: {
      sandbox: true,
      partition: `persist:t3-browser-${threadId}`,
    },
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  const session: DesktopBrowserSession = {
    threadId,
    view,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    isVisible: false,
    state: createEmptyBrowserState(threadId),
  };

  const sync = () => {
    updateBrowserSessionState(session);
  };

  view.webContents.on("did-start-loading", sync);
  view.webContents.on("did-stop-loading", sync);
  view.webContents.on("did-navigate", sync);
  view.webContents.on("did-navigate-in-page", sync);
  view.webContents.on("page-title-updated", sync);
  view.webContents.on("destroyed", () => {
    browserSessions.delete(threadId);
    if (activeBrowserThreadId === threadId) {
      activeBrowserThreadId = null;
    }
  });

  browserSessions.set(threadId, session);
  return session;
}

async function attachBrowserThread(threadId: string): Promise<DesktopBrowserViewState> {
  const session = ensureBrowserSession(threadId);
  if (session.state.url === null) {
    try {
      await session.view.webContents.loadURL("about:blank");
    } catch (error) {
      if (!isRecoverableBrowserLoadError(error)) {
        throw error;
      }
    }
  }
  attachBrowserSessionToWindow(threadId);
  return updateBrowserSessionState(session);
}

function setBrowserVisibility(
  threadId: string,
  visible: boolean,
  bounds?: DesktopBrowserViewBounds,
): DesktopBrowserViewState {
  const session = ensureBrowserSession(threadId);
  session.isVisible = visible;
  session.bounds = sanitizeBrowserBounds(bounds ?? session.bounds);

  if (!visible) {
    if (activeBrowserThreadId === threadId) {
      attachBrowserSessionToWindow(null);
    }
    return updateBrowserSessionState(session);
  }

  if (session.view.webContents.isDestroyed()) {
    browserSessions.delete(threadId);
    return createEmptyBrowserState(threadId);
  }
  attachBrowserSessionToWindow(threadId);
  if (session.bounds.width > 0 && session.bounds.height > 0) {
    session.view.setBounds(session.bounds);
  }
  return updateBrowserSessionState(session);
}

async function navigateBrowser(threadId: string, rawUrl: string): Promise<DesktopBrowserViewState> {
  const session = ensureBrowserSession(threadId);
  const normalizedUrl = normalizeBrowserUrl(rawUrl);
  try {
    await session.view.webContents.loadURL(normalizedUrl);
  } catch (error) {
    if (!isRecoverableBrowserLoadError(error)) {
      throw error;
    }
  }
  return updateBrowserSessionState(session);
}

async function observeBrowser(
  threadId: string,
  target?: string,
): Promise<DesktopBrowserObserveResult> {
  const session = ensureBrowserSession(threadId);
  return observeBrowserView(session.view, threadId, target);
}

async function actOnBrowser(
  threadId: string,
  action: DesktopBrowserActInput,
): Promise<DesktopBrowserActionResult> {
  const session = ensureBrowserSession(threadId);
  const result = await actOnBrowserView(
    session.view,
    threadId,
    action,
    updateBrowserSessionState(session),
  );
  return {
    ...result,
    state: updateBrowserSessionState(session),
  };
}

async function extractFromBrowser(
  threadId: string,
  query?: string,
): Promise<DesktopBrowserExtractResult> {
  const session = ensureBrowserSession(threadId);
  return extractBrowserView(session.view, threadId, query);
}

async function observeBrowserForOperator(
  threadId: string,
  target?: string,
): Promise<DesktopOperatorObserveResponse> {
  const session = ensureBrowserSession(threadId);
  const observation = await observeBrowserView(session.view, threadId, target);
  const screenshotBase64 = await captureBrowserViewScreenshot(session.view);
  return {
    state: updateBrowserSessionState(session),
    observation,
    screenshotBase64,
  };
}

async function extractBrowserForOperator(
  threadId: string,
  query?: string,
): Promise<DesktopOperatorExtractResponse> {
  const session = ensureBrowserSession(threadId);
  const extraction = await extractBrowserView(session.view, threadId, query);
  return {
    state: updateBrowserSessionState(session),
    extraction,
  };
}

async function waitForBrowser(
  threadId: string,
  durationMs: number,
): Promise<DesktopBrowserViewState> {
  const session = ensureBrowserSession(threadId);
  const safeDuration = Math.max(0, Math.min(30_000, Math.floor(durationMs)));
  await new Promise((resolve) => setTimeout(resolve, safeDuration));
  return updateBrowserSessionState(session);
}

function browserBack(threadId: string): DesktopBrowserViewState {
  const session = ensureBrowserSession(threadId);
  if (session.view.webContents.navigationHistory.canGoBack()) {
    session.view.webContents.navigationHistory.goBack();
  }
  return updateBrowserSessionState(session);
}

function browserForward(threadId: string): DesktopBrowserViewState {
  const session = ensureBrowserSession(threadId);
  if (session.view.webContents.navigationHistory.canGoForward()) {
    session.view.webContents.navigationHistory.goForward();
  }
  return updateBrowserSessionState(session);
}

function browserReload(threadId: string): DesktopBrowserViewState {
  const session = ensureBrowserSession(threadId);
  session.view.webContents.reload();
  return updateBrowserSessionState(session);
}

async function readJsonRequestBody(request: Http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJsonResponse(
  response: Http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function operatorUnauthorized(response: Http.ServerResponse): void {
  writeJsonResponse(response, 401, {
    ok: false,
    error: "Unauthorized operator request.",
  });
}

function isAuthorizedOperatorRequest(request: Http.IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  return authorization === `Bearer ${operatorApiToken}`;
}

async function handleOperatorRpc(method: string, params: Record<string, unknown>): Promise<DesktopOperatorRpcResult> {
  const threadIdValue = params.threadId;
  const threadId =
    typeof threadIdValue === "string" && threadIdValue.trim().length > 0
      ? threadIdValue.trim()
      : null;
  if (!threadId) {
    throw new Error("Operator request requires a threadId.");
  }

  switch (method) {
    case "browser.attach":
      return attachBrowserThread(threadId);
    case "browser.getState":
      return updateBrowserSessionState(ensureBrowserSession(threadId));
    case "browser.navigate": {
      const url = params.url;
      if (typeof url !== "string") {
        throw new Error("Operator browser.navigate requires a URL.");
      }
      return navigateBrowser(threadId, url);
    }
    case "browser.goBack":
      return browserBack(threadId);
    case "browser.goForward":
      return browserForward(threadId);
    case "browser.reload":
      return browserReload(threadId);
    case "browser.observe":
      return observeBrowserForOperator(
        threadId,
        typeof params.target === "string" ? params.target : undefined,
      );
    case "browser.extract":
      return extractBrowserForOperator(
        threadId,
        typeof params.query === "string" ? params.query : undefined,
      );
    case "browser.wait": {
      const durationMs = params.durationMs;
      if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
        throw new Error("Operator browser.wait requires a finite durationMs.");
      }
      return waitForBrowser(threadId, durationMs);
    }
    case "browser.act": {
      const action = params.action;
      if (!action || typeof action !== "object") {
        throw new Error("Operator browser.act requires an action payload.");
      }
      return actOnBrowser(threadId, action as DesktopBrowserActInput);
    }
    default:
      throw new Error(`Unsupported operator method: ${method}`);
  }
}

async function startOperatorApiServer(): Promise<void> {
  if (operatorApiServer) {
    return;
  }

  operatorApiToken = Crypto.randomBytes(24).toString("hex");
  const server = Http.createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== "POST" || request.url !== DESKTOP_OPERATOR_PATH) {
          writeJsonResponse(response, 404, { ok: false, error: "Not found." });
          return;
        }
        if (!isAuthorizedOperatorRequest(request)) {
          operatorUnauthorized(response);
          return;
        }
        const body = await readJsonRequestBody(request);
        if (!body || typeof body !== "object") {
          writeJsonResponse(response, 400, { ok: false, error: "Invalid operator request body." });
          return;
        }

        const method = (body as { method?: unknown }).method;
        const params = (body as { params?: unknown }).params;
        if (typeof method !== "string") {
          writeJsonResponse(response, 400, { ok: false, error: "Missing operator method." });
          return;
        }

        const result = await handleOperatorRpc(
          method,
          params && typeof params === "object" ? (params as Record<string, unknown>) : {},
        );
        writeJsonResponse(response, 200, { ok: true, result });
      } catch (error) {
        writeJsonResponse(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DESKTOP_OPERATOR_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to resolve operator API address.");
  }

  operatorApiServer = server;
  operatorApiUrl = `http://${DESKTOP_OPERATOR_HOST}:${address.port}${DESKTOP_OPERATOR_PATH}`;
}

async function stopOperatorApiServer(): Promise<void> {
  const server = operatorApiServer;
  operatorApiServer = null;
  operatorApiUrl = "";
  operatorApiToken = "";
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function checkForUpdates(reason: string): Promise<void> {
  if (isQuitting || !updaterConfigured || updateCheckInFlight) return;
  if (updateState.status === "downloading" || updateState.status === "downloaded") {
    console.info(
      `[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`,
    );
    return;
  }
  updateCheckInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, new Date().toISOString()));
  console.info(`[desktop-updater] Checking for updates (${reason})...`);

  try {
    await autoUpdater.checkForUpdates();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnCheckFailure(updateState, message, new Date().toISOString()));
    console.error(`[desktop-updater] Failed to check for updates: ${message}`);
  } finally {
    updateCheckInFlight = false;
  }
}

async function downloadAvailableUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") {
    return { accepted: false, completed: false };
  }
  updateDownloadInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
  console.info("[desktop-updater] Downloading update...");

  try {
    await autoUpdater.downloadUpdate();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Failed to download update: ${message}`);
    return { accepted: true, completed: false };
  } finally {
    updateDownloadInFlight = false;
  }
}

async function installDownloadedUpdate(): Promise<{ accepted: boolean; completed: boolean }> {
  if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") {
    return { accepted: false, completed: false };
  }

  isQuitting = true;
  clearUpdatePollTimer();
  try {
    await stopBackendAndWaitForExit();
    autoUpdater.quitAndInstall();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    isQuitting = false;
    setUpdateState(reduceDesktopUpdateStateOnInstallFailure(updateState, message));
    console.error(`[desktop-updater] Failed to install update: ${message}`);
    return { accepted: true, completed: false };
  }
}

function configureAutoUpdater(): void {
  const enabled = shouldEnableAutoUpdates();
  setUpdateState({
    ...createInitialDesktopUpdateState(app.getVersion()),
    enabled,
    status: enabled ? "idle" : "disabled",
  });
  if (!enabled) {
    return;
  }
  updaterConfigured = true;

  const githubToken =
    process.env.T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    "";
  if (githubToken) {
    // When a token is provided, re-configure the feed with `private: true` so
    // electron-updater uses the GitHub API (api.github.com) instead of the
    // public Atom feed (github.com/…/releases.atom) which rejects Bearer auth.
    const appUpdateYml = readAppUpdateYml();
    if (appUpdateYml?.provider === "github") {
      autoUpdater.setFeedURL({
        ...appUpdateYml,
        provider: "github" as const,
        private: true,
        token: githubToken,
      });
    }
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Keep alpha branding, but force all installs onto the stable update track.
  autoUpdater.channel = DESKTOP_UPDATE_CHANNEL;
  autoUpdater.allowPrerelease = DESKTOP_UPDATE_ALLOW_PRERELEASE;
  autoUpdater.allowDowngrade = false;
  let lastLoggedDownloadMilestone = -1;

  autoUpdater.on("checking-for-update", () => {
    console.info("[desktop-updater] Looking for updates...");
  });
  autoUpdater.on("update-available", (info) => {
    setUpdateState(reduceDesktopUpdateStateOnUpdateAvailable(updateState, info.version, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info(`[desktop-updater] Update available: ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info("[desktop-updater] No updates available.");
  });
  autoUpdater.on("error", (error) => {
    const message = formatErrorMessage(error);
    if (!updateCheckInFlight && !updateDownloadInFlight) {
      setUpdateState({
        status: "error",
        message,
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        errorContext: resolveUpdaterErrorContext(),
        canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null,
      });
    }
    console.error(`[desktop-updater] Updater error: ${message}`);
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.floor(progress.percent);
    if (
      shouldBroadcastDownloadProgress(updateState, progress.percent) ||
      updateState.message !== null
    ) {
      setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
    }
    const milestone = percent - (percent % 10);
    if (milestone > lastLoggedDownloadMilestone) {
      lastLoggedDownloadMilestone = milestone;
      console.info(`[desktop-updater] Download progress: ${percent}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
    console.info(`[desktop-updater] Update downloaded: ${info.version}`);
  });

  clearUpdatePollTimer();

  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates("startup");
  }, AUTO_UPDATE_STARTUP_DELAY_MS);
  updateStartupTimer.unref();

  updatePollTimer = setInterval(() => {
    void checkForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  updatePollTimer.unref();
}
function backendEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    T3CODE_MODE: "desktop",
    T3CODE_NO_BROWSER: "1",
    T3CODE_PORT: String(backendPort),
    T3CODE_STATE_DIR: STATE_DIR,
    T3CODE_AUTH_TOKEN: backendAuthToken,
    ...(operatorApiUrl ? { T3CODE_DESKTOP_OPERATOR_URL: operatorApiUrl } : {}),
    ...(operatorApiToken ? { T3CODE_DESKTOP_OPERATOR_TOKEN: operatorApiToken } : {}),
  };
}

function scheduleBackendRestart(reason: string): void {
  if (isQuitting || restartTimer) return;

  const delayMs = Math.min(500 * 2 ** restartAttempt, 10_000);
  restartAttempt += 1;
  console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBackend();
  }, delayMs);
}

function startBackend(): void {
  if (isQuitting || backendProcess) return;

  const backendEntry = resolveBackendEntry();
  if (!FS.existsSync(backendEntry)) {
    scheduleBackendRestart(`missing server entry at ${backendEntry}`);
    return;
  }

  const captureBackendLogs = app.isPackaged && backendLogSink !== null;
  const child = ChildProcess.spawn(process.execPath, [backendEntry], {
    cwd: resolveBackendCwd(),
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    env: {
      ...backendEnv(),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: captureBackendLogs ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  backendProcess = child;
  let backendSessionClosed = false;
  const closeBackendSession = (details: string) => {
    if (backendSessionClosed) return;
    backendSessionClosed = true;
    writeBackendSessionBoundary("END", details);
  };
  writeBackendSessionBoundary(
    "START",
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`,
  );
  captureBackendOutput(child);

  child.once("spawn", () => {
    restartAttempt = 0;
  });

  child.on("error", (error) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(
      `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    if (isQuitting) return;
    const reason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
    scheduleBackendRestart(reason);
  });
}

function stopBackend(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2_000).unref();
  }
}

function destroyBrowserSessions(): void {
  attachBrowserSessionToWindow(null);
  for (const session of browserSessions.values()) {
    session.view.webContents.close({ waitForBeforeUnload: false });
  }
  browserSessions.clear();
}

async function stopBackendAndWaitForExit(timeoutMs = 5_000): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;
  const backendChild = child;
  if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    function settle(): void {
      if (settled) return;
      settled = true;
      backendChild.off("exit", onExit);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (exitTimeoutTimer) {
        clearTimeout(exitTimeoutTimer);
      }
      resolve();
    }

    function onExit(): void {
      settle();
    }

    backendChild.once("exit", onExit);
    backendChild.kill("SIGTERM");

    forceKillTimer = setTimeout(() => {
      if (backendChild.exitCode === null && backendChild.signalCode === null) {
        backendChild.kill("SIGKILL");
      }
    }, 2_000);
    forceKillTimer.unref();

    exitTimeoutTimer = setTimeout(() => {
      settle();
    }, timeoutMs);
    exitTimeoutTimer.unref();
  });
}

function registerIpcHandlers(): void {
  ipcMain.removeHandler(PICK_FOLDER_CHANNEL);
  ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(CONFIRM_CHANNEL);
  ipcMain.handle(CONFIRM_CHANNEL, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
    return showDesktopConfirmDialog(message, owner);
  });

  ipcMain.removeHandler(CONTEXT_MENU_CHANNEL);
  ipcMain.handle(
    CONTEXT_MENU_CHANNEL,
    async (_event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = items
        .filter((item) => typeof item.id === "string" && typeof item.label === "string")
        .map((item) => ({
          id: item.id,
          label: item.label,
          destructive: item.destructive === true,
        }));
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const template: MenuItemConstructorOptions[] = [];
        let hasInsertedDestructiveSeparator = false;
        for (const item of normalizedItems) {
          if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
            template.push({ type: "separator" });
            hasInsertedDestructiveSeparator = true;
          }
          const itemOption: MenuItemConstructorOptions = {
            label: item.label,
            click: () => resolve(item.id),
          };
          if (item.destructive) {
            const destructiveIcon = getDestructiveMenuIcon();
            if (destructiveIcon) {
              itemOption.icon = destructiveIcon;
            }
          }
          template.push(itemOption);
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({
          window,
          ...popupPosition,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.removeHandler(OPEN_EXTERNAL_CHANNEL);
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== "string" || rawUrl.length === 0) {
      return false;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return false;
    }

    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return false;
    }

    try {
      await shell.openExternal(parsedUrl.toString());
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL);
  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, async () => updateState);

  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL);
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    const result = await downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(UPDATE_INSTALL_CHANNEL);
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, async () => {
    if (isQuitting) {
      return {
        accepted: false,
        completed: false,
        state: updateState,
      } satisfies DesktopUpdateActionResult;
    }
    const result = await installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(BROWSER_ATTACH_CHANNEL);
  ipcMain.handle(BROWSER_ATTACH_CHANNEL, async (_event, threadId: unknown) => {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      throw new Error("Invalid browser thread id.");
    }
    return attachBrowserThread(threadId);
  });

  ipcMain.removeHandler(BROWSER_SET_VISIBLE_CHANNEL);
  ipcMain.handle(
    BROWSER_SET_VISIBLE_CHANNEL,
    async (_event, threadId: unknown, visible: unknown, bounds: unknown) => {
      if (typeof threadId !== "string" || threadId.trim().length === 0) {
        throw new Error("Invalid browser thread id.");
      }
      if (typeof visible !== "boolean") {
        throw new Error("Invalid browser visibility value.");
      }
      const safeBounds =
        bounds && typeof bounds === "object"
          ? sanitizeBrowserBounds(bounds as DesktopBrowserViewBounds)
          : undefined;
      return setBrowserVisibility(threadId, visible, safeBounds);
    },
  );

  ipcMain.removeHandler(BROWSER_NAVIGATE_CHANNEL);
  ipcMain.handle(BROWSER_NAVIGATE_CHANNEL, async (_event, threadId: unknown, url: unknown) => {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      throw new Error("Invalid browser thread id.");
    }
    if (typeof url !== "string") {
      throw new Error("Invalid browser URL.");
    }
    return navigateBrowser(threadId, url);
  });

  ipcMain.removeHandler(BROWSER_GO_BACK_CHANNEL);
  ipcMain.handle(BROWSER_GO_BACK_CHANNEL, async (_event, threadId: unknown) => {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      throw new Error("Invalid browser thread id.");
    }
    return browserBack(threadId);
  });

  ipcMain.removeHandler(BROWSER_GO_FORWARD_CHANNEL);
  ipcMain.handle(BROWSER_GO_FORWARD_CHANNEL, async (_event, threadId: unknown) => {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      throw new Error("Invalid browser thread id.");
    }
    return browserForward(threadId);
  });

  ipcMain.removeHandler(BROWSER_RELOAD_CHANNEL);
  ipcMain.handle(BROWSER_RELOAD_CHANNEL, async (_event, threadId: unknown) => {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      throw new Error("Invalid browser thread id.");
    }
    return browserReload(threadId);
  });

  ipcMain.removeHandler(BROWSER_GET_STATE_CHANNEL);
  ipcMain.handle(BROWSER_GET_STATE_CHANNEL, async (_event, threadId: unknown) => {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      throw new Error("Invalid browser thread id.");
    }
    const session = ensureBrowserSession(threadId);
    return updateBrowserSessionState(session);
  });

  ipcMain.removeHandler(BROWSER_OBSERVE_CHANNEL);
  ipcMain.handle(BROWSER_OBSERVE_CHANNEL, async (_event, threadId: unknown, target: unknown) => {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      throw new Error("Invalid browser thread id.");
    }
    if (target !== undefined && typeof target !== "string") {
      throw new Error("Invalid browser observe target.");
    }
    return observeBrowser(threadId, typeof target === "string" ? target : undefined);
  });

  ipcMain.removeHandler(BROWSER_ACT_CHANNEL);
  ipcMain.handle(BROWSER_ACT_CHANNEL, async (_event, threadId: unknown, action: unknown) => {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      throw new Error("Invalid browser thread id.");
    }
    if (!action || typeof action !== "object") {
      throw new Error("Invalid browser action.");
    }
    return actOnBrowser(threadId, action as DesktopBrowserActInput);
  });

  ipcMain.removeHandler(BROWSER_EXTRACT_CHANNEL);
  ipcMain.handle(BROWSER_EXTRACT_CHANNEL, async (_event, threadId: unknown, query: unknown) => {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      throw new Error("Invalid browser thread id.");
    }
    if (query !== undefined && typeof query !== "string") {
      throw new Error("Invalid browser extract query.");
    }
    return extractFromBrowser(threadId, typeof query === "string" ? query : undefined);
  });

  ipcMain.removeHandler(BROWSER_WAIT_CHANNEL);
  ipcMain.handle(BROWSER_WAIT_CHANNEL, async (_event, threadId: unknown, durationMs: unknown) => {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      throw new Error("Invalid browser thread id.");
    }
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
      throw new Error("Invalid browser wait duration.");
    }
    return waitForBrowser(threadId, durationMs);
  });
}

function getIconOption(): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = process.platform === "win32" ? "ico" : "png";
  const iconPath = resolveIconPath(ext);
  return iconPath ? { icon: iconPath } : {};
}

function desktopBootScreenDataUrl(): string {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"
    />
    <title>${APP_DISPLAY_NAME}</title>
    <style>
      :root {
        color-scheme: dark;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", Inter, sans-serif;
        background:
          radial-gradient(44rem 16rem at top, rgba(59, 130, 246, 0.18), transparent),
          linear-gradient(145deg, #050505 0%, #0a0a0c 52%, #050505 100%);
        color: rgba(255, 255, 255, 0.96);
        display: grid;
        place-items: center;
      }
      .panel {
        width: min(620px, calc(100vw - 48px));
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 28px;
        background: rgba(12, 12, 16, 0.82);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(18px);
        padding: 28px;
      }
      .eyebrow {
        font-size: 11px;
        letter-spacing: 0.24em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.45);
        font-weight: 700;
      }
      h1 {
        margin: 14px 0 0;
        font-size: clamp(32px, 5vw, 48px);
        line-height: 1.02;
      }
      p {
        margin: 18px 0 0;
        color: rgba(255, 255, 255, 0.62);
        font-size: 15px;
        line-height: 1.8;
      }
      .progress {
        margin-top: 28px;
        height: 8px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.08);
      }
      .progress > div {
        height: 100%;
        width: 32%;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.82);
        animation: pulse 1.2s ease-in-out infinite alternate;
      }
      @keyframes pulse {
        from { transform: translateX(0); opacity: 0.55; }
        to { transform: translateX(180%); opacity: 1; }
      }
    </style>
  </head>
  <body>
    <section class="panel">
      <div class="eyebrow">Desktop Shell</div>
      <h1>Opening ${APP_DISPLAY_NAME}</h1>
      <p>Starting the local server, restoring workspace state, and preparing Codex, terminal, Lab, and Canvas.</p>
      <div class="progress"><div></div></div>
    </section>
  </body>
</html>`;

  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 840,
    minHeight: 620,
    show: false,
    backgroundColor: "#050505",
    autoHideMenuBar: true,
    ...getIconOption(),
    title: APP_DISPLAY_NAME,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: Path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const appUrl = isDevelopment
    ? (process.env.VITE_DEV_SERVER_URL as string)
    : `${DESKTOP_SCHEME}://app/index.html`;
  let rendererRequested = false;

  const requestRendererLoad = () => {
    if (rendererRequested) {
      return;
    }
    rendererRequested = true;
    void window.loadURL(appUrl);
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      const isHttps = parsed.protocol === "https:";
      const isAllowedAuthHost =
        hostname === "accounts.google.com" ||
        hostname === "github.com" ||
        hostname.endsWith(".github.com") ||
        hostname.endsWith(".clerk.accounts.dev") ||
        hostname.endsWith(".clerk.com");

      if (isHttps && isAllowedAuthHost) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 520,
            height: 760,
            minWidth: 420,
            minHeight: 620,
            autoHideMenuBar: true,
            titleBarStyle: "default",
            backgroundColor: "#050505",
            modal: false,
            webPreferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
            },
          },
        };
      }
    } catch {
      if (url === "about:blank") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 520,
            height: 760,
            minWidth: 420,
            minHeight: 620,
            autoHideMenuBar: true,
            title: `${APP_DISPLAY_NAME} Auth`,
            titleBarStyle: "default",
            backgroundColor: "#050505",
            modal: false,
            webPreferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
            },
          },
        };
      }
    }

    return { action: "deny" };
  });
  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_DISPLAY_NAME);
  });
  window.webContents.on("did-finish-load", () => {
    const currentUrl = window.webContents.getURL();

    if (currentUrl.startsWith("data:text/html")) {
      window.setTitle(APP_DISPLAY_NAME);
      if (!window.isVisible()) {
        window.show();
      }
      requestRendererLoad();
      return;
    }

    window.setTitle(APP_DISPLAY_NAME);
    emitUpdateState();
    if (activeBrowserThreadId) {
      attachBrowserSessionToWindow(activeBrowserThreadId);
    }
    if (!window.isVisible()) {
      window.show();
    }
    if (isDevelopment && OPEN_DEVTOOLS_IN_DEV) {
      window.webContents.openDevTools({ mode: "detach" });
    }
  });

  void window.loadURL(desktopBootScreenDataUrl());

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

configureAppIdentity();

async function bootstrap(): Promise<void> {
  writeDesktopLogHeader("bootstrap start");
  backendPort = await Effect.service(NetService).pipe(
    Effect.flatMap((net) => net.reserveLoopbackPort()),
    Effect.provide(NetService.layer),
    Effect.runPromise,
  );
  writeDesktopLogHeader(`reserved backend port via NetService port=${backendPort}`);
  backendAuthToken = Crypto.randomBytes(24).toString("hex");
  backendWsUrl = `ws://127.0.0.1:${backendPort}/?token=${encodeURIComponent(backendAuthToken)}`;
  process.env.T3CODE_DESKTOP_WS_URL = backendWsUrl;
  writeDesktopLogHeader(`bootstrap resolved websocket url=${backendWsUrl}`);
  await startOperatorApiServer();
  writeDesktopLogHeader(`bootstrap operator api url=${operatorApiUrl}`);

  registerIpcHandlers();
  writeDesktopLogHeader("bootstrap ipc handlers registered");
  startBackend();
  writeDesktopLogHeader("bootstrap backend start requested");
  mainWindow = createWindow();
  writeDesktopLogHeader("bootstrap main window created");

  // First-run dependency check — only runs once per install
  const bootstrapMarker = Path.join(STATE_DIR, ".deps-checked");
  if (!FS.existsSync(bootstrapMarker)) {
    void runFirstRunBootstrap(mainWindow)
      .then(() => {
        FS.mkdirSync(Path.dirname(bootstrapMarker), { recursive: true });
        FS.writeFileSync(bootstrapMarker, new Date().toISOString());
        writeDesktopLogHeader("first-run dependency bootstrap complete");
      })
      .catch((err) => {
        writeDesktopLogHeader(`first-run dependency bootstrap error: ${err}`);
      });
  }
}

app.on("before-quit", () => {
  isQuitting = true;
  writeDesktopLogHeader("before-quit received");
  clearUpdatePollTimer();
  destroyBrowserSessions();
  stopBackend();
  void stopOperatorApiServer();
  restoreStdIoCapture?.();
});

app
  .whenReady()
  .then(() => {
    writeDesktopLogHeader("app ready");
    configureAppIdentity();
    configureApplicationMenu();
    registerDesktopProtocol();
    configureAutoUpdater();
    void bootstrap().catch((error) => {
      handleFatalStartupError("bootstrap", error);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  })
  .catch((error) => {
    handleFatalStartupError("whenReady", error);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

if (process.platform !== "win32") {
  process.on("SIGINT", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGINT received");
    clearUpdatePollTimer();
    stopBackend();
    void stopOperatorApiServer();
    restoreStdIoCapture?.();
    app.quit();
  });

  process.on("SIGTERM", () => {
    if (isQuitting) return;
    isQuitting = true;
    writeDesktopLogHeader("SIGTERM received");
    clearUpdatePollTimer();
    stopBackend();
    void stopOperatorApiServer();
    restoreStdIoCapture?.();
    app.quit();
  });
}
