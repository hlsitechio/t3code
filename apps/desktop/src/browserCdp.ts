import type { BrowserView, WebContents } from "electron";

const DEBUGGER_PROTOCOL_VERSION = "1.3";
const attachedContents = new WeakSet<WebContents>();

function ensureDebuggerAttached(webContents: WebContents): void {
  if (webContents.isDestroyed()) {
    throw new Error("Browser target is no longer available.");
  }

  if (webContents.debugger.isAttached()) {
    attachedContents.add(webContents);
    return;
  }

  try {
    webContents.debugger.attach(DEBUGGER_PROTOCOL_VERSION);
    attachedContents.add(webContents);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("already attached")
    ) {
      attachedContents.add(webContents);
      return;
    }
    throw error;
  }
}

async function sendCommand<T>(
  webContents: WebContents,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  ensureDebuggerAttached(webContents);
  return webContents.debugger.sendCommand(method, params) as Promise<T>;
}

export async function captureBrowserViewScreenshot(view: BrowserView): Promise<string | null> {
  const webContents = view.webContents;
  if (webContents.isDestroyed()) {
    return null;
  }

  try {
    const result = await sendCommand<{ data?: string }>(webContents, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true,
    });
    return typeof result.data === "string" && result.data.length > 0 ? result.data : null;
  } catch {
    return null;
  }
}
