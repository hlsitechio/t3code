import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  EDITORS,
  DEFAULT_MODEL,
  appBootstrapResultSchema,
  appHealthResultSchema,
  dialogsPickFolderResultSchema,
  type ProviderSession,
  type WsClientMessage,
  type WsResponseMessage,
  type WsServerMessage,
  WS_EVENT_CHANNELS,
  WS_ERROR_CODE_MAX_CHARS,
  WS_ERROR_MESSAGE_MAX_CHARS,
  WS_CLOSE_CODES,
  WS_CLOSE_REASONS,
  agentConfigSchema,
  agentSessionIdSchema,
  agentWriteInputSchema,
  newTodoInputSchema,
  todoIdSchema,
  providerInterruptTurnInputSchema,
  providerRespondToRequestInputSchema,
  providerSendTurnInputSchema,
  providerSessionListSchema,
  providerSessionStartInputSchema,
  providerSessionSchema,
  providerStopSessionInputSchema,
  providerTurnStartResultSchema,
  type TerminalCommandInput,
  shellOpenInEditorInputSchema,
  terminalCommandResultSchema,
  terminalCommandInputSchema,
  todoListSchema,
  wsClientMessageSchema,
  wsNativeApiMethodSchema,
  wsServerMessageSchema,
} from "@acme/contracts";
import { ProcessManager, ProviderManager, TodoStore } from "@acme/runtime-core";

interface RuntimeApiServerOptions {
  port: number;
  launchCwd: string;
  bootstrapSessionTimeoutMs?: number;
  authToken?: string;
}

interface RuntimeApiServer {
  wsUrl: string;
  close: () => Promise<void>;
}

interface JsonRpcErrorResult {
  code: string;
  message: string;
}

const BOOTSTRAP_SESSION_TIMEOUT_MS = 3_000;
const MAX_BOOTSTRAP_SESSION_TIMEOUT_MS = 120_000;
const MAX_WS_CLIENT_PAYLOAD_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_PATH_CHARS = 2_048;

interface BootstrapSessionResult {
  session: ProviderSession;
  bootstrapError: string | undefined;
}

type WsServerEventMessage = Extract<WsServerMessage, { type: "event" }>;

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    timeout.unref();

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function responseSuccess(id: string, result: unknown): WsResponseMessage {
  return {
    type: "response",
    id,
    ok: true,
    result: result === undefined ? null : result,
  };
}

function responseError(id: string, error: JsonRpcErrorResult): WsResponseMessage {
  const normalizedCode = normalizeErrorField(
    error.code,
    "request_failed",
    WS_ERROR_CODE_MAX_CHARS,
  );
  const normalizedMessage = normalizeErrorField(
    error.message,
    "Request failed",
    WS_ERROR_MESSAGE_MAX_CHARS,
  );
  return {
    type: "response",
    id,
    ok: false,
    error: {
      code: normalizedCode,
      message: normalizedMessage,
    },
  };
}

function normalizeErrorField(value: string, fallback: string, maxChars: number): string {
  const trimmed = value.trim();
  const safeValue = trimmed.length > 0 ? trimmed : fallback;
  if (safeValue.length <= maxChars) {
    return safeValue;
  }

  if (maxChars <= 1) {
    return safeValue.slice(0, maxChars);
  }

  return `${safeValue.slice(0, maxChars - 1)}…`;
}

function summarizePathForError(candidatePath: string): string {
  if (candidatePath.length <= MAX_ERROR_PATH_CHARS) {
    return candidatePath;
  }

  const prefixLength = Math.floor((MAX_ERROR_PATH_CHARS - 1) / 2);
  const suffixLength = MAX_ERROR_PATH_CHARS - 1 - prefixLength;
  return `${candidatePath.slice(0, prefixLength)}…${candidatePath.slice(-suffixLength)}`;
}

function sendMessage(socket: WebSocket, message: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const parsedMessage = wsServerMessageSchema.safeParse(message);
  if (!parsedMessage.success) {
    return;
  }

  try {
    socket.send(JSON.stringify(parsedMessage.data));
  } catch {
    // Best-effort event delivery. Socket may have transitioned states.
  }
}

function decodeClientMessage(raw: RawData): string | null {
  if (typeof raw === "string") {
    return raw;
  }

  if (raw instanceof Buffer) {
    return raw.toString("utf8");
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }

  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }

  return null;
}

function openPathInFileManager(targetPath: string): void {
  const command =
    process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";

  const child = spawn(command, [targetPath], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // Best-effort shell handoff.
  });
  child.unref();
}

async function tryCommand(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on("error", () => {
      resolve(null);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      const trimmed = output.trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    });
  });
}

async function pickFolder(): Promise<string | null> {
  if (process.platform === "darwin") {
    const script =
      'try\nset selectedFolder to POSIX path of (choose folder with prompt "Choose a project folder")\nreturn selectedFolder\non error\nreturn ""\nend try';
    const result = await tryCommand("osascript", ["-e", script]);
    return result && result.length > 0 ? result : null;
  }

  if (process.platform === "win32") {
    const powershellScript = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      '$dialog.Description = "Choose a project folder"',
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  Write-Output $dialog.SelectedPath",
      "}",
    ].join("; ");
    const result = await tryCommand("powershell", ["-NoProfile", "-Command", powershellScript]);
    return result && result.length > 0 ? result : null;
  }

  const zenity = await tryCommand("zenity", ["--file-selection", "--directory"]);
  if (zenity) {
    return zenity;
  }

  const kdialog = await tryCommand("kdialog", ["--getexistingdirectory"]);
  if (kdialog) {
    return kdialog;
  }

  return null;
}

async function runTerminalCommand(
  parsed: TerminalCommandInput,
  defaultCwd: string,
) {
  const providedCwd = parsed.cwd ?? defaultCwd;
  const resolvedCwd = resolveExistingDirectoryFromBase(
    providedCwd,
    "Working directory",
    defaultCwd,
  );

  const shellPath =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : (process.env.SHELL ?? "/bin/sh");
  const args =
    process.platform === "win32" ? ["/d", "/s", "/c", parsed.command] : ["-lc", parsed.command];

  return new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    signal: string | null;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn(shellPath, args, {
      cwd: resolvedCwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 1_000).unref();
    }, parsed.timeoutMs ?? 30_000);
    timeout.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        code: code ?? null,
        signal: signal ?? null,
        timedOut,
      });
    });
  });
}

function resolveExistingDirectory(targetPath: string, label: string): string {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    throw new Error(`${label} must be a non-empty path.`);
  }

  const candidate = path.resolve(targetPath);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const safeCandidate = summarizePathForError(candidate);
    if (code && code !== "ENOENT") {
      throw new Error(`Failed to access ${label.toLowerCase()}: ${safeCandidate} (${code})`, {
        cause: error,
      });
    }
    throw new Error(`${label} does not exist: ${safeCandidate}`, {
      cause: error,
    });
  }

  if (!stats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${summarizePathForError(candidate)}`);
  }

  return candidate;
}

function resolveExistingDirectoryFromBase(
  targetPath: string,
  label: string,
  baseDirectory: string,
): string {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    throw new Error(`${label} must be a non-empty path.`);
  }

  const candidate = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(baseDirectory, targetPath);
  return resolveExistingDirectory(candidate, label);
}

export async function startRuntimeApiServer(
  options: RuntimeApiServerOptions,
): Promise<RuntimeApiServer> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("Invalid runtime port: expected integer between 0 and 65535.");
  }
  const launchCwd = resolveExistingDirectory(options.launchCwd, "Invalid launchCwd");
  if (options.authToken !== undefined && typeof options.authToken !== "string") {
    throw new Error("Invalid runtime auth token: expected non-empty string.");
  }
  const authToken = options.authToken?.trim();
  if (options.authToken !== undefined && !authToken) {
    throw new Error("Invalid runtime auth token: expected non-empty string.");
  }
  const bootstrapSessionTimeoutMs =
    options.bootstrapSessionTimeoutMs ?? BOOTSTRAP_SESSION_TIMEOUT_MS;
  if (
    !Number.isInteger(bootstrapSessionTimeoutMs) ||
    bootstrapSessionTimeoutMs <= 0 ||
    bootstrapSessionTimeoutMs > MAX_BOOTSTRAP_SESSION_TIMEOUT_MS
  ) {
    throw new Error(
      `Invalid bootstrapSessionTimeoutMs: expected integer between 1 and ${MAX_BOOTSTRAP_SESSION_TIMEOUT_MS}.`,
    );
  }
  const providerManager = new ProviderManager();
  const processManager = new ProcessManager();
  const todoStore = new TodoStore(path.join(os.homedir(), ".t3", "todos.json"));
  await todoStore.init();

  let activeClient: WebSocket | null = null;
  let launchSessionPromise: Promise<BootstrapSessionResult> | null = null;
  let bootstrapFallbackSession: ProviderSession | null = null;

  const emitEvent = <TChannel extends WsServerEventMessage["channel"]>(
    channel: TChannel,
    payload: Extract<WsServerEventMessage, { channel: TChannel }>["payload"],
  ) => {
    if (!activeClient) {
      return;
    }

    sendMessage(activeClient, {
      type: "event",
      channel,
      payload,
    });
  };

  processManager.on("output", (chunk) => {
    emitEvent(WS_EVENT_CHANNELS.agentOutput, chunk);
  });
  processManager.on("exit", (payload) => {
    emitEvent(WS_EVENT_CHANNELS.agentExit, payload);
  });
  providerManager.on("event", (payload) => {
    emitEvent(WS_EVENT_CHANNELS.providerEvent, payload);
  });

  const createBootstrapErrorSession = (message: string): ProviderSession => {
    const timestamp = new Date().toISOString();
    return {
      sessionId: `bootstrap-error-${Date.now()}`,
      provider: "codex",
      status: "error",
      cwd: launchCwd,
      model: DEFAULT_MODEL,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastError: message,
    };
  };

  const ensureLaunchSession = async (): Promise<BootstrapSessionResult> => {
    const isLaunchProjectSession = (session: ProviderSession) => {
      if (!session.cwd) {
        return false;
      }

      return path.resolve(session.cwd) === launchCwd;
    };

    const existingSession = providerManager
      .listSessions()
      .find((session) => isLaunchProjectSession(session) && session.status !== "closed");
    if (existingSession) {
      bootstrapFallbackSession = null;
      return {
        session: existingSession,
        bootstrapError: undefined,
      };
    }

    if (bootstrapFallbackSession) {
      return {
        session: bootstrapFallbackSession,
        bootstrapError: bootstrapFallbackSession.lastError,
      };
    }

    if (launchSessionPromise) {
      return launchSessionPromise;
    }

    launchSessionPromise = (async () => {
      try {
        const startedSession = await raceWithTimeout(
          providerManager.startSession({
            provider: "codex",
            cwd: launchCwd,
            model: DEFAULT_MODEL,
            approvalPolicy: "never",
            sandboxMode: "danger-full-access",
          }),
          bootstrapSessionTimeoutMs,
          "Timed out starting launch session.",
        );
        bootstrapFallbackSession = null;
        return {
          session: startedSession,
          bootstrapError: undefined,
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to initialize Codex launch session.";
        const fallbackSession = (() => {
          if (!bootstrapFallbackSession) {
            return createBootstrapErrorSession(message);
          }

          return Object.assign({}, bootstrapFallbackSession, {
            lastError: message,
            updatedAt: new Date().toISOString(),
          }) as ProviderSession;
        })();
        bootstrapFallbackSession = fallbackSession;
        return {
          session: fallbackSession,
          bootstrapError: message,
        };
      } finally {
        launchSessionPromise = null;
      }
    })();

    const pendingLaunchSessionPromise = launchSessionPromise;
    if (!pendingLaunchSessionPromise) {
      throw new Error("Could not initialize launch session promise.");
    }
    return pendingLaunchSessionPromise;
  };

  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: options.port,
    maxPayload: MAX_WS_CLIENT_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  const isAuthorizedConnection = (requestUrl: string | undefined) => {
    if (!requestUrl) {
      return authToken === null;
    }

    try {
      const request = new URL(requestUrl, "ws://127.0.0.1");
      if (request.pathname !== "/") {
        return false;
      }

      if (!authToken) {
        return request.searchParams.size === 0;
      }

      const tokens = request.searchParams.getAll("token");
      return (
        request.searchParams.size === 1 &&
        tokens.length === 1 &&
        tokens[0] === authToken
      );
    } catch {
      return false;
    }
  };

  const resolveMethod = async (method: string, params: unknown) => {
    const parsedMethod = wsNativeApiMethodSchema.safeParse(method);
    if (!parsedMethod.success) {
      throw new Error(`Unknown API method: ${method}`);
    }

    const apiMethod = parsedMethod.data;
    switch (apiMethod) {
      case "app.bootstrap": {
        const bootstrap = await ensureLaunchSession();
        const payload = {
          launchCwd,
          projectName: path.basename(launchCwd) || launchCwd,
          provider: "codex",
          model: bootstrap.session.model ?? DEFAULT_MODEL,
          session: bootstrap.session,
          ...(bootstrap.bootstrapError
            ? { bootstrapError: bootstrap.bootstrapError }
            : {}),
        };
        return appBootstrapResultSchema.parse(payload);
      }

      case "app.health": {
        const payload = {
          status: "ok",
          launchCwd,
          sessionCount: providerManager.listSessions().length,
          activeClientConnected: activeClient !== null,
        };
        return appHealthResultSchema.parse(payload);
      }

      case "todos.list":
        return todoListSchema.parse(await todoStore.list());
      case "todos.add":
        return todoListSchema.parse(await todoStore.add(newTodoInputSchema.parse(params)));
      case "todos.toggle":
        return todoListSchema.parse(await todoStore.toggle(todoIdSchema.parse(params)));
      case "todos.remove":
        return todoListSchema.parse(await todoStore.remove(todoIdSchema.parse(params)));

      case "dialogs.pickFolder":
        return dialogsPickFolderResultSchema.parse(await pickFolder());
      case "terminal.run":
        return terminalCommandResultSchema.parse(
          await runTerminalCommand(terminalCommandInputSchema.parse(params), launchCwd),
        );

      case "agent.spawn":
        return agentSessionIdSchema.parse(processManager.spawn(agentConfigSchema.parse(params)));
      case "agent.kill":
        processManager.kill(agentSessionIdSchema.parse(params));
        return null;
      case "agent.write": {
        const parsed = agentWriteInputSchema.parse(params);
        processManager.write(parsed.sessionId, parsed.data);
        return null;
      }

      case "providers.startSession": {
        const session = await providerManager.startSession(
          providerSessionStartInputSchema.parse(params),
        );
        bootstrapFallbackSession = null;
        return providerSessionSchema.parse(session);
      }
      case "providers.sendTurn":
        return providerTurnStartResultSchema.parse(
          await providerManager.sendTurn(providerSendTurnInputSchema.parse(params)),
        );
      case "providers.interruptTurn":
        await providerManager.interruptTurn(providerInterruptTurnInputSchema.parse(params));
        return null;
      case "providers.respondToRequest":
        await providerManager.respondToRequest(providerRespondToRequestInputSchema.parse(params));
        return null;
      case "providers.stopSession":
        providerManager.stopSession(providerStopSessionInputSchema.parse(params));
        return null;
      case "providers.listSessions":
        return providerSessionListSchema.parse(providerManager.listSessions());

      case "shell.openInEditor": {
        const parsed = shellOpenInEditorInputSchema.parse(params);
        const targetPath = resolveExistingDirectoryFromBase(parsed.cwd, "Editor target", launchCwd);

        const editor = EDITORS.find((entry) => entry.id === parsed.editor);
        if (!editor) {
          throw new Error(`Unknown editor: ${parsed.editor}`);
        }

        if (!editor.command) {
          openPathInFileManager(targetPath);
          return null;
        }

        const child = spawn(editor.command, [targetPath], {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", () => {
          // Best-effort editor launch.
        });
        child.unref();
        return null;
      }

      default: {
        const unreachableMethod: never = apiMethod;
        throw new Error(`Unknown API method: ${unreachableMethod}`);
      }
    }
  };

  wss.on("connection", (socket, request) => {
    if (!isAuthorizedConnection(request.url)) {
      socket.close(WS_CLOSE_CODES.unauthorized, WS_CLOSE_REASONS.unauthorized);
      return;
    }

    if (activeClient && activeClient !== socket) {
      activeClient.close(
        WS_CLOSE_CODES.replacedByNewClient,
        WS_CLOSE_REASONS.replacedByNewClient,
      );
    }

    activeClient = socket;
    sendMessage(socket, {
      type: "hello",
      version: 1,
      launchCwd,
    });

    socket.on("message", async (raw) => {
      const decoded = decodeClientMessage(raw);
      if (!decoded) {
        return;
      }

      const maybeParsed = (() => {
        try {
          return JSON.parse(decoded) as unknown;
        } catch {
          return null;
        }
      })();

      if (!maybeParsed) {
        return;
      }

      const parsed = wsClientMessageSchema.safeParse(maybeParsed);
      if (!parsed.success) {
        return;
      }

      const message = parsed.data as WsClientMessage;
      try {
        const result = await resolveMethod(message.method, message.params);
        sendMessage(socket, responseSuccess(message.id, result));
      } catch (error) {
        sendMessage(
          socket,
          responseError(message.id, {
            code: "request_failed",
            message: error instanceof Error ? error.message : "Request failed",
          }),
        );
      }
    });

    socket.on("close", () => {
      if (activeClient === socket) {
        activeClient = null;
      }
    });
    socket.on("error", () => {
      // Connection-level protocol/socket errors are expected occasionally
      // (for example oversized client payloads). Keep server process alive.
      if (activeClient === socket && socket.readyState !== WebSocket.OPEN) {
        activeClient = null;
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      if (wss.address()) {
        resolve();
        return;
      }

      const onListening = () => {
        wss.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        wss.off("listening", onListening);
        reject(error);
      };

      wss.once("listening", onListening);
      wss.once("error", onError);
    });
  } catch (error) {
    processManager.killAll();
    providerManager.stopAll();
    providerManager.dispose();
    await new Promise<void>((resolve) => {
      try {
        wss.close(() => resolve());
      } catch {
        resolve();
      }
    });
    throw error;
  }

  const address = wss.address();
  const resolvedPort =
    typeof address === "object" && address !== null ? address.port : options.port;
  const wsBaseUrl = `ws://127.0.0.1:${resolvedPort}`;
  const wsUrl = authToken
    ? `${wsBaseUrl}?token=${encodeURIComponent(authToken)}`
    : wsBaseUrl;
  let closePromise: Promise<void> | null = null;

  return {
    wsUrl,
    close() {
      if (closePromise) {
        return closePromise;
      }

      closePromise = (async () => {
        processManager.killAll();
        providerManager.stopAll();
        providerManager.dispose();
        activeClient = null;
        for (const client of wss.clients) {
          client.terminate();
        }
        await new Promise<void>((resolve) => {
          wss.close(() => resolve());
        });
      })();

      return closePromise;
    },
  };
}
