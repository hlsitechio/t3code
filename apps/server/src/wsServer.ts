/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import http from "node:http";
import { spawn } from "node:child_process";
import type { Duplex } from "node:stream";

import Mime from "@effect/platform-node/Mime";
import {
  type CanvasFile,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ClientOrchestrationCommand,
  KeybindingRule,
  MAX_SCRIPT_ID_LENGTH,
  type OrchestrationCommand,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ThreadId,
  type ThreadCanvasState,
  TerminalEvent,
  type ServerProviderStatus,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  WsPush,
  WsResponse,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
  ServiceMap,
  Stream,
  Struct,
} from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { GitManager } from "./git/Services/GitManager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { Keybindings } from "./keybindings";
import { searchWorkspaceEntries } from "./workspaceEntries";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { clamp } from "effect/Number";
import { Open, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { expandHomePath } from "./os-jank.ts";

/**
 * ServerShape - Service API for server lifecycle control.
 */
export interface ServerShape {
  /**
   * Start HTTP and WebSocket listeners.
   */
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError,
    Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >;

  /**
   * Wait for process shutdown signals.
   */
  readonly stopSignal: Effect.Effect<void, never>;
}

/**
 * Server - Service tag for HTTP/WebSocket lifecycle management.
 */
export class Server extends ServiceMap.Service<Server, ServerShape>()("t3/wsServer/Server") {}

const isServerNotRunningError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

const OPERATOR_ROUTE_PATH = "/__t3_operator";
const CANVAS_STATE_DIRECTORY = "canvas";

const DEFAULT_CANVAS_FILES: readonly CanvasFile[] = [
  {
    path: "src/App.jsx",
    language: "jsx",
    contents: `export default function App() {
  return (
    <main className="app-shell">
      <section className="hero-card">
        <span className="eyebrow">T3 Canvas</span>
        <h1>Build the next React surface here.</h1>
        <p>
          This canvas is separate from the Lab browser. Use it for generated UI, app concepts, and
          interactive React previews.
        </p>
        <div className="hero-actions">
          <button type="button">Primary action</button>
          <button type="button" className="secondary">
            Secondary action
          </button>
        </div>
      </section>
    </main>
  );
}
`,
  },
  {
    path: "src/styles.css",
    language: "css",
    contents: `.app-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 40px;
  background:
    radial-gradient(circle at top, rgba(90, 120, 255, 0.18), transparent 34%),
    linear-gradient(180deg, #09090b 0%, #0f1115 100%);
  color: #f8fafc;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

.hero-card {
  width: min(720px, 100%);
  padding: 32px;
  border-radius: 28px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(12, 14, 18, 0.88);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
}

.eyebrow {
  display: inline-flex;
  margin-bottom: 16px;
  border-radius: 999px;
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(248, 250, 252, 0.72);
  font-size: 12px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.hero-card h1 {
  margin: 0;
  font-size: clamp(2rem, 4vw, 3.75rem);
  line-height: 1.05;
}

.hero-card p {
  margin: 16px 0 0;
  max-width: 56ch;
  color: rgba(248, 250, 252, 0.76);
  line-height: 1.7;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 28px;
}

.hero-actions button {
  border: 0;
  border-radius: 999px;
  padding: 12px 18px;
  background: #4f46e5;
  color: white;
  font: inherit;
}

.hero-actions .secondary {
  background: rgba(255, 255, 255, 0.08);
}
`,
  },
  {
    path: "canvas.md",
    language: "md",
    contents:
      "# Canvas brief\n\nDescribe the app you want here, then let the agent reshape the React files and preview.\n",
  },
] as const;

function defaultThreadCanvasState(threadId: ThreadId): ThreadCanvasState {
  return {
    threadId,
    title: "Canvas App",
    framework: "react",
    prompt: "",
    files: [...DEFAULT_CANVAS_FILES],
    lastUpdatedAt: new Date().toISOString(),
  };
}

function canvasStatePath(stateDir: string, path: Path.Path, threadId: ThreadId): string {
  return path.join(stateDir, CANVAS_STATE_DIRECTORY, `${threadId}.json`);
}

function normalizeProjectScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    return "script";
  }
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeProjectScriptId(name);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
    suffix += 1;
  }

  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

function commandForProjectScript(scriptId: string): `script.${string}.run` {
  return `script.${scriptId}.run`;
}

async function readJsonRequestBody(request: http.IncomingMessage): Promise<unknown> {
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
  response: http.ServerResponse,
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

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message,
  );
}

function websocketRawToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks: string[] = [];
    for (const chunk of raw) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
        continue;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        continue;
      }
      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(new Uint8Array(chunk)).toString("utf8"));
        continue;
      }
      return null;
    }
    return chunks.join("");
  }
  return null;
}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function resolveWorkspaceWritePath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const absolutePath = params.path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRoot, absolutePath),
  );
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    params.path.isAbsolute(relativeToRoot)
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.succeed({
    absolutePath,
    relativePath: relativeToRoot,
  });
}

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

function messageFromCause(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  const message =
    squashed instanceof Error ? squashed.message.trim() : String(squashed).trim();
  return message.length > 0 ? message : Cause.pretty(cause);
}

interface CliProbeDescriptor {
  id: "github-cli" | "claude-cli" | "gemini-cli";
  commands: readonly string[];
  versionArgs: readonly string[];
}

function runCommandCapture(command: string, args: readonly string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", () => {
      resolve({ exitCode: -1, stdout: "", stderr: "" });
    });
    child.on("close", (code) => {
      resolve({
        exitCode: typeof code === "number" ? code : -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

async function detectCommandPath(command: string): Promise<string | null> {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = await runCommandCapture(locator, [command]);
  if (result.exitCode !== 0) {
    return null;
  }
  const firstLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? null;
}

async function detectCliInstallation(descriptor: CliProbeDescriptor): Promise<{
  id: CliProbeDescriptor["id"];
  found: boolean;
  command: string;
  path?: string;
  version?: string;
  authenticated?: boolean;
  message?: string;
}> {
  for (const command of descriptor.commands) {
    const foundPath = await detectCommandPath(command);
    if (!foundPath) continue;
    const versionResult = await runCommandCapture(foundPath, descriptor.versionArgs);
    const versionLine = versionResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    let authenticated: boolean | undefined;
    if (descriptor.id === "github-cli") {
      const authResult = await runCommandCapture(foundPath, ["auth", "status"]);
      authenticated = authResult.exitCode === 0;
    }

    return {
      id: descriptor.id,
      found: true,
      command,
      path: foundPath,
      ...(versionLine ? { version: versionLine } : {}),
      ...(authenticated !== undefined ? { authenticated } : {}),
      ...(versionResult.exitCode !== 0 ? { message: "Found, but version check failed." } : {}),
    };
  }
  return {
    id: descriptor.id,
    found: false,
    command: descriptor.commands[0] ?? "unknown",
    message: "CLI not found in PATH.",
  };
}

export type ServerCoreRuntimeServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointDiffQuery
  | OrchestrationReactor
  | ProviderService
  | ProviderHealth;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | GitManager
  | GitCore
  | TerminalManager
  | Keybindings
  | Open
  | AnalyticsService;

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()("RouteRequestError", {
  message: Schema.String,
}) {}

export const createServer = Effect.fn(function* (): Effect.fn.Return<
  http.Server,
  ServerLifecycleError,
  Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const serverConfig = yield* ServerConfig;
  const {
    port,
    cwd,
    keybindingsConfigPath,
    staticDir,
    devUrl,
    authToken,
    host,
    logWebSocketEvents,
    autoBootstrapProjectFromCwd,
  } = serverConfig;
  const availableEditors = resolveAvailableEditors();

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const keybindingsManager = yield* Keybindings;
  const providerHealth = yield* ProviderHealth;
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* keybindingsManager.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );

  const fallbackProviderStatuses: readonly ServerProviderStatus[] = [
    {
      provider: "codex",
      status: "warning",
      available: false,
      authStatus: "unknown",
      checkedAt: new Date().toISOString(),
      message: "Provider health check pending.",
    },
  ];

  const providerStatuses = yield* providerHealth.getStatuses.pipe(
    Effect.timeoutOption(800),
    Effect.map((maybeStatuses) =>
      Option.getOrElse(maybeStatuses, () => fallbackProviderStatuses),
    ),
    Effect.catch(() => Effect.succeed(fallbackProviderStatuses)),
  );

  const clients = yield* Ref.make(new Set<WebSocket>());
  const logger = createLogger("ws");

  function logOutgoingPush(push: WsPush, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      recipients,
      payload: push.data,
    });
  }

  const encodePush = Schema.encodeEffect(Schema.fromJsonString(WsPush));
  const broadcastPush = Effect.fnUntraced(function* (push: WsPush) {
    const message = yield* encodePush(push);
    let recipients = 0;
    for (const client of yield* Ref.get(clients)) {
      if (client.readyState === client.OPEN) {
        client.send(message);
        recipients += 1;
      }
    }
    logOutgoingPush(push, recipients);
  });

  const onTerminalEvent = Effect.fnUntraced(function* (event: TerminalEvent) {
    yield* broadcastPush({
      type: "push",
      channel: WS_CHANNELS.terminalEvent,
      data: event,
    });
  });

  const normalizeDispatchCommand = Effect.fnUntraced(function* (input: {
    readonly command: ClientOrchestrationCommand;
  }) {
    const normalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
      const normalizedWorkspaceRoot = path.resolve(yield* expandHomePath(workspaceRoot.trim()));
      const workspaceStat = yield* fileSystem
        .stat(normalizedWorkspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!workspaceStat) {
        return yield* new RouteRequestError({
          message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
        });
      }
      if (workspaceStat.type !== "Directory") {
        return yield* new RouteRequestError({
          message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
        });
      }
      return normalizedWorkspaceRoot;
    });

    if (input.command.type === "project.create") {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (
      input.command.type === "project.meta.update" &&
      input.command.workspaceRoot !== undefined
    ) {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const turnStartCommand = input.command;

    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new RouteRequestError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new RouteRequestError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(turnStartCommand.threadId);
          if (!attachmentId) {
            return yield* new RouteRequestError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            stateDir: serverConfig.stateDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new RouteRequestError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

  // HTTP server — serves static files or redirects to Vite dev server
  const httpServer = http.createServer((req, res) => {
    const respond = (
      statusCode: number,
      headers: Record<string, string>,
      body?: string | Uint8Array,
    ) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };

    void Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (url.pathname === OPERATOR_ROUTE_PATH) {
          if (req.method !== "POST") {
            respond(405, { "Content-Type": "text/plain" }, "Method Not Allowed");
            return;
          }
          const expectedAuthToken = serverConfig.authToken;
          const authorization = req.headers.authorization;
          if (!expectedAuthToken || authorization !== `Bearer ${expectedAuthToken}`) {
            writeJsonResponse(res, 401, {
              ok: false,
              error: "Unauthorized operator request.",
            });
            return;
          }

          const requestBody = yield* Effect.tryPromise({
            try: () => readJsonRequestBody(req),
            catch: () => null,
          });
          if (!requestBody || typeof requestBody !== "object") {
            writeJsonResponse(res, 400, { ok: false, error: "Invalid operator request body." });
            return;
          }

          const method =
            "method" in requestBody && typeof requestBody.method === "string"
              ? requestBody.method
              : null;
          const params =
            "params" in requestBody && requestBody.params && typeof requestBody.params === "object"
              ? (requestBody.params as Record<string, unknown>)
              : {};
          if (!method) {
            writeJsonResponse(res, 400, { ok: false, error: "Missing operator method." });
            return;
          }

          const threadId =
            typeof params.threadId === "string" && params.threadId.trim().length > 0
              ? ThreadId.makeUnsafe(params.threadId.trim())
              : null;
          if (!threadId) {
            writeJsonResponse(res, 400, { ok: false, error: "Operator request requires a threadId." });
            return;
          }

          const snapshot = yield* projectionReadModelQuery.getSnapshot();
          const thread = snapshot.threads.find((entry) => entry.id === threadId && entry.deletedAt === null);
          if (!thread) {
            writeJsonResponse(res, 404, { ok: false, error: `Unknown thread '${threadId}'.` });
            return;
          }
          const project = snapshot.projects.find(
            (entry) => entry.id === thread.projectId && entry.deletedAt === null,
          );
          if (!project) {
            writeJsonResponse(res, 404, { ok: false, error: `Unknown project '${thread.projectId}'.` });
            return;
          }

          const readOperatorCanvasState = (): Effect.Effect<ThreadCanvasState> =>
            Effect.gen(function* () {
              const filePath = canvasStatePath(serverConfig.stateDir, path, thread.id);
              const persisted = yield* fileSystem.readFileString(filePath).pipe(
                Effect.catch(() => Effect.succeed(null)),
              );
              if (!persisted) {
                return defaultThreadCanvasState(thread.id);
              }
              try {
                const parsed = JSON.parse(persisted) as Partial<ThreadCanvasState>;
                return {
                  ...defaultThreadCanvasState(thread.id),
                  ...parsed,
                  threadId: thread.id,
                  lastUpdatedAt:
                    typeof parsed.lastUpdatedAt === "string" && parsed.lastUpdatedAt.length > 0
                      ? parsed.lastUpdatedAt
                      : new Date().toISOString(),
                  files: Array.isArray(parsed.files)
                    ? parsed.files.filter(
                        (file): file is CanvasFile =>
                          !!file &&
                          typeof file === "object" &&
                          typeof file.path === "string" &&
                          (file.language === "jsx" ||
                            file.language === "css" ||
                            file.language === "md") &&
                          typeof file.contents === "string",
                      )
                    : [...DEFAULT_CANVAS_FILES],
                };
              } catch {
                return defaultThreadCanvasState(thread.id);
              }
            });

          const writeOperatorCanvasState = (canvasState: ThreadCanvasState) =>
            Effect.gen(function* () {
              const filePath = canvasStatePath(serverConfig.stateDir, path, canvasState.threadId);
              yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
              yield* fileSystem.writeFileString(filePath, JSON.stringify(canvasState, null, 2));
            });

          switch (method) {
            case "app.getContext": {
              const canvas = yield* readOperatorCanvasState();
              writeJsonResponse(res, 200, {
                ok: true,
                result: {
                  thread: {
                    id: thread.id,
                    title: thread.title,
                    model: thread.model,
                    runtimeMode: thread.runtimeMode,
                    interactionMode: thread.interactionMode,
                  },
                  project: {
                    id: project.id,
                    title: project.title,
                    workspaceRoot: project.workspaceRoot,
                    defaultModel: project.defaultModel,
                    actions: project.scripts,
                  },
                  canvas: {
                    title: canvas.title,
                    framework: canvas.framework,
                    fileCount: canvas.files.length,
                    lastUpdatedAt: canvas.lastUpdatedAt,
                  },
                },
              });
              return;
            }

            case "actions.list": {
              writeJsonResponse(res, 200, {
                ok: true,
                result: project.scripts,
              });
              return;
            }

            case "actions.create": {
              const name = typeof params.name === "string" ? params.name.trim() : "";
              const command = typeof params.command === "string" ? params.command.trim() : "";
              const keybinding =
                typeof params.keybinding === "string" ? params.keybinding.trim() : null;
              const icon =
                params.icon === "play" ||
                params.icon === "test" ||
                params.icon === "lint" ||
                params.icon === "configure" ||
                params.icon === "build" ||
                params.icon === "debug"
                  ? params.icon
                  : "play";
              const runOnWorktreeCreate = params.runOnWorktreeCreate === true;

              if (name.length === 0) {
                writeJsonResponse(res, 400, { ok: false, error: "Action name is required." });
                return;
              }
              if (command.length === 0) {
                writeJsonResponse(res, 400, { ok: false, error: "Action command is required." });
                return;
              }

              const nextId = nextProjectScriptId(
                name,
                project.scripts.map((script) => script.id),
              );
              const nextAction = {
                id: nextId,
                name,
                command,
                icon,
                runOnWorktreeCreate,
              } as const;
              const nextScripts = runOnWorktreeCreate
                ? [
                    ...project.scripts.map((script) =>
                      script.runOnWorktreeCreate
                        ? { ...script, runOnWorktreeCreate: false }
                        : script,
                    ),
                    nextAction,
                  ]
                : [...project.scripts, nextAction];

              yield* orchestrationEngine.dispatch({
                type: "project.meta.update",
                commandId: CommandId.makeUnsafe(crypto.randomUUID()),
                projectId: project.id,
                scripts: nextScripts,
              });

              if (keybinding) {
                let keybindingRule: typeof KeybindingRule.Type;
                try {
                  keybindingRule = Schema.decodeUnknownSync(KeybindingRule)({
                    key: keybinding,
                    command: commandForProjectScript(nextId),
                  });
                } catch {
                  writeJsonResponse(res, 400, { ok: false, error: "Invalid action keybinding." });
                  return;
                }
                yield* keybindingsManager.upsertKeybindingRule(keybindingRule);
              }

              writeJsonResponse(res, 200, {
                ok: true,
                result: {
                  projectId: project.id,
                  action: nextAction,
                  actionCount: nextScripts.length,
                },
              });
              return;
            }

            case "canvas.getState": {
              const canvas = yield* readOperatorCanvasState();
              writeJsonResponse(res, 200, {
                ok: true,
                result: canvas,
              });
              return;
            }

            case "canvas.update": {
              const existing = yield* readOperatorCanvasState();
              const title = typeof params.title === "string" ? params.title : existing.title;
              const prompt = typeof params.prompt === "string" ? params.prompt : existing.prompt;
              const files = Array.isArray(params.files)
                ? params.files.filter(
                    (file): file is CanvasFile =>
                      !!file &&
                      typeof file === "object" &&
                      typeof file.path === "string" &&
                      (file.language === "jsx" || file.language === "css" || file.language === "md") &&
                      typeof file.contents === "string",
                  )
                : existing.files;
              const nextCanvasState: ThreadCanvasState = {
                ...existing,
                title,
                prompt,
                files: files.length > 0 ? files : existing.files,
                lastUpdatedAt: new Date().toISOString(),
              };
              yield* writeOperatorCanvasState(nextCanvasState);
              writeJsonResponse(res, 200, {
                ok: true,
                result: nextCanvasState,
              });
              return;
            }

            default: {
              writeJsonResponse(res, 404, { ok: false, error: `Unknown operator method '${method}'.` });
              return;
            }
          }
        }
        if (tryHandleProjectFaviconRequest(url, res)) {
          return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
          const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
          const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
          if (!normalizedRelativePath) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
            return;
          }

          const isIdLookup =
            !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
          const filePath = isIdLookup
            ? resolveAttachmentPathById({
                stateDir: serverConfig.stateDir,
                attachmentId: normalizedRelativePath,
              })
            : resolveAttachmentRelativePath({
                stateDir: serverConfig.stateDir,
                relativePath: normalizedRelativePath,
              });
          if (!filePath) {
            respond(
              isIdLookup ? 404 : 400,
              { "Content-Type": "text/plain" },
              isIdLookup ? "Not Found" : "Invalid attachment path",
            );
            return;
          }

          const fileInfo = yield* fileSystem
            .stat(filePath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }

          const contentType = Mime.getType(filePath) ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          const streamExit = yield* Stream.runForEach(fileSystem.stream(filePath), (chunk) =>
            Effect.sync(() => {
              if (!res.destroyed) {
                res.write(chunk);
              }
            }),
          ).pipe(Effect.exit);
          if (streamExit._tag === "Failure") {
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }

        // In dev mode, redirect to Vite dev server
        if (devUrl) {
          respond(302, { Location: devUrl.href });
          return;
        }

        // Serve static files from the web app build
        if (!staticDir) {
          respond(
            503,
            { "Content-Type": "text/plain" },
            "No static directory configured and no dev URL set.",
          );
          return;
        }

        const staticRoot = path.resolve(staticDir);
        const staticRequestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
        const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
        const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
        const hasPathTraversalSegment = staticRelativePath.startsWith("..");
        if (
          staticRelativePath.length === 0 ||
          hasRawLeadingParentSegment ||
          hasPathTraversalSegment ||
          staticRelativePath.includes("\0")
        ) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const isWithinStaticRoot = (candidate: string) =>
          candidate === staticRoot ||
          candidate.startsWith(
            staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`,
          );

        let filePath = path.resolve(staticRoot, staticRelativePath);
        if (!isWithinStaticRoot(filePath)) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const ext = path.extname(filePath);
        if (!ext) {
          filePath = path.resolve(filePath, "index.html");
          if (!isWithinStaticRoot(filePath)) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
            return;
          }
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          const indexPath = path.resolve(staticRoot, "index.html");
          const indexData = yield* fileSystem
            .readFile(indexPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!indexData) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }
          respond(200, { "Content-Type": "text/html; charset=utf-8" }, indexData);
          return;
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        const data = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) {
          respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
          return;
        }
        respond(200, { "Content-Type": contentType }, data);
      }),
    ).catch(() => {
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
    });
  });

  // WebSocket server — upgrades from the HTTP server
  const wss = new WebSocketServer({ noServer: true });

  const closeWebSocketServer = Effect.callback<void, ServerLifecycleError>((resume) => {
    wss.close((error) => {
      if (error && !isServerNotRunningError(error)) {
        resume(
          Effect.fail(
            new ServerLifecycleError({ operation: "closeWebSocketServer", cause: error }),
          ),
        );
      } else {
        resume(Effect.void);
      }
    });
  });

  const closeAllClients = Ref.get(clients).pipe(
    Effect.flatMap(Effect.forEach((client) => Effect.sync(() => client.close()))),
    Effect.flatMap(() => Ref.set(clients, new Set())),
  );

  const listenOptions = host ? { host, port } : { port };

  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const orchestrationReactor = yield* OrchestrationReactor;
  const { openInEditor } = yield* Open;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    broadcastPush({
      type: "push",
      channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
      data: event,
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(keybindingsManager.changes, (event) =>
    broadcastPush({
      type: "push",
      channel: WS_CHANNELS.serverConfigUpdated,
      data: {
        issues: event.issues,
        providers: providerStatuses,
      },
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);

  let welcomeBootstrapProjectId: ProjectId | undefined;
  let welcomeBootstrapThreadId: ThreadId | undefined;

  if (autoBootstrapProjectFromCwd) {
    const bootstrapFromCwd = Effect.gen(function* () {
      const snapshot = yield* projectionReadModelQuery.getSnapshot();
      const existingProject = snapshot.projects.find(
        (project) => project.workspaceRoot === cwd && project.deletedAt === null,
      );
      let bootstrapProjectId: ProjectId;
      let bootstrapProjectDefaultModel: string;

      if (!existingProject) {
        const createdAt = new Date().toISOString();
        bootstrapProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(cwd) || "project";
        bootstrapProjectDefaultModel = "gpt-5-codex";
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: bootstrapProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: cwd,
          defaultModel: bootstrapProjectDefaultModel,
          createdAt,
        });
      } else {
        bootstrapProjectId = existingProject.id;
        bootstrapProjectDefaultModel = existingProject.defaultModel ?? "gpt-5-codex";
      }

      const existingThread = snapshot.threads.find(
        (thread) => thread.projectId === bootstrapProjectId && thread.deletedAt === null,
      );
      if (!existingThread) {
        const createdAt = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: bootstrapProjectDefaultModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = threadId;
      } else {
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = existingThread.id;
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("auto bootstrap from cwd failed", { cwd, cause }),
      ),
    );
    yield* bootstrapFromCwd.pipe(Effect.forkIn(subscriptionsScope));
  }

  const runtimeServices = yield* Effect.services<
    ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const runPromise = Effect.runPromiseWith(runtimeServices);

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void Effect.runPromise(onTerminalEvent(event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));

  yield* NodeHttpServer.make(() => httpServer, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([
      closeAllClients,
      closeWebSocketServer.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to close web socket server", { cause: error }),
        ),
      ),
    ]),
  );

  const routeRequest = Effect.fnUntraced(function* (request: WebSocketRequest) {
    const readCanvasState = Effect.fnUntraced(function* (threadId: ThreadId) {
      const filePath = canvasStatePath(serverConfig.stateDir, path, threadId);
      const persisted = yield* fileSystem
        .readFileString(filePath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!persisted) {
        return defaultThreadCanvasState(threadId);
      }
      try {
        const parsed = JSON.parse(persisted) as Partial<ThreadCanvasState>;
        return {
          ...defaultThreadCanvasState(threadId),
          ...parsed,
          threadId,
          lastUpdatedAt:
            typeof parsed.lastUpdatedAt === "string" && parsed.lastUpdatedAt.length > 0
              ? parsed.lastUpdatedAt
              : new Date().toISOString(),
          files: Array.isArray(parsed.files)
            ? parsed.files.filter(
                (file): file is CanvasFile =>
                  !!file &&
                  typeof file === "object" &&
                  typeof file.path === "string" &&
                  (file.language === "jsx" || file.language === "css" || file.language === "md") &&
                  typeof file.contents === "string",
              )
            : [...DEFAULT_CANVAS_FILES],
        };
      } catch {
        return defaultThreadCanvasState(threadId);
      }
    });

    const writeCanvasState = Effect.fnUntraced(function* (canvasState: ThreadCanvasState) {
      const filePath = canvasStatePath(serverConfig.stateDir, path, canvasState.threadId);
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fileSystem.writeFileString(filePath, JSON.stringify(canvasState, null, 2));
      return canvasState;
    });

    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSnapshot();

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = request.body;
        const normalizedCommand = yield* normalizeDispatchCommand({ command });
        return yield* orchestrationEngine.dispatch(normalizedCommand);
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getFullThreadDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = request.body;
        return yield* Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
          ),
        ).pipe(Effect.map((events) => Array.from(events)));
      }

      case WS_METHODS.projectsSearchEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => searchWorkspaceEntries(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to search workspace entries: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsWriteFile: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveWorkspaceWritePath({
          workspaceRoot: body.cwd,
          relativePath: body.relativePath,
          path,
        });
        yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to prepare workspace path: ${String(cause)}`,
              }),
          ),
        );
        yield* fileSystem.writeFileString(target.absolutePath, body.contents).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to write workspace file: ${String(cause)}`,
              }),
          ),
        );
        return { relativePath: target.relativePath };
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(request.body);
        return yield* openInEditor(body);
      }

      case WS_METHODS.githubStartDeviceFlow: {
        return yield* Effect.tryPromise({
          try: () => import("./git/githubDeviceFlow").then((m) => m.requestGitHubDeviceCode()),
          catch: (cause) => new Error(cause instanceof Error ? cause.message : "Device flow failed"),
        });
      }

      case WS_METHODS.githubPollDeviceFlow: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () =>
            import("./git/githubDeviceFlow").then((m) =>
              m.pollGitHubDeviceFlow(body.deviceCode, body.interval, body.expiresIn),
            ),
          catch: (cause) => new Error(cause instanceof Error ? cause.message : "Polling failed"),
        });
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.status(body);
      }

      case WS_METHODS.gitPull: {
        const body = stripRequestTag(request.body);
        return yield* git.pullCurrentBranch(body.cwd);
      }

      case WS_METHODS.gitRunStackedAction: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.runStackedAction(body);
      }

      case WS_METHODS.gitListBranches: {
        const body = stripRequestTag(request.body);
        return yield* git.listBranches(body);
      }

      case WS_METHODS.gitCreateWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.createWorktree(body);
      }

      case WS_METHODS.gitRemoveWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.removeWorktree(body);
      }

      case WS_METHODS.gitCreateBranch: {
        const body = stripRequestTag(request.body);
        return yield* git.createBranch(body);
      }

      case WS_METHODS.gitCheckout: {
        const body = stripRequestTag(request.body);
        return yield* Effect.scoped(git.checkoutBranch(body));
      }

      case WS_METHODS.gitInit: {
        const body = stripRequestTag(request.body);
        return yield* git.initRepo(body);
      }

      case WS_METHODS.terminalOpen: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.open(body);
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.write(body);
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.resize(body);
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.clear(body);
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.restart(body);
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.close(body);
      }

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        return {
          cwd,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers: providerStatuses,
          availableEditors,
        };

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(request.body);
        const keybindingsConfig = yield* keybindingsManager.upsertKeybindingRule(body);
        return { keybindings: keybindingsConfig, issues: [] };
      }

      case WS_METHODS.serverDetectCliInstallations: {
        return yield* Effect.tryPromise({
          try: async () => {
            const probes: readonly CliProbeDescriptor[] = [
              {
                id: "github-cli",
                commands: ["gh"],
                versionArgs: ["--version"],
              },
              {
                id: "claude-cli",
                commands: ["claude"],
                versionArgs: ["--version"],
              },
              {
                id: "gemini-cli",
                commands: ["gemini", "gemini-cli"],
                versionArgs: ["--version"],
              },
            ];
            return Promise.all(probes.map((probe) => detectCliInstallation(probe)));
          },
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to detect CLI installations: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.canvasGetState: {
        const body = stripRequestTag(request.body);
        return yield* readCanvasState(body.threadId);
      }

      case WS_METHODS.canvasUpsertState: {
        const body = stripRequestTag(request.body);
        const existing = yield* readCanvasState(body.threadId);
        return yield* writeCanvasState({
          ...existing,
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
          ...(body.files ? { files: body.files } : {}),
          lastUpdatedAt: new Date().toISOString(),
        });
      }

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const handleMessage = Effect.fnUntraced(function* (ws: WebSocket, raw: unknown) {
    const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(WsResponse));

    const messageText = websocketRawToString(raw);
    if (messageText === null) {
      const errorResponse = yield* encodeResponse({
        id: "unknown",
        error: { message: "Invalid request format: Failed to read message" },
      });
      ws.send(errorResponse);
      return;
    }

    const request = Schema.decodeUnknownExit(Schema.fromJsonString(WebSocketRequest))(messageText);
    if (request._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: "unknown",
        error: { message: `Invalid request format: ${messageFromCause(request.cause)}` },
      });
      ws.send(errorResponse);
      return;
    }

    const result = yield* Effect.exit(routeRequest(request.value));
    if (result._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: request.value.id,
        error: { message: messageFromCause(result.cause) },
      });
      ws.send(errorResponse);
      return;
    }

    const response = yield* encodeResponse({
      id: request.value.id,
      result: result.value,
    });

    ws.send(response);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

    if (authToken) {
      let providedToken: string | null = null;
      try {
        const url = new URL(request.url ?? "/", `http://localhost:${port}`);
        providedToken = url.searchParams.get("token");
      } catch {
        rejectUpgrade(socket, 400, "Invalid WebSocket URL");
        return;
      }

      if (providedToken !== authToken) {
        rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    void runPromise(Ref.update(clients, (clients) => clients.add(ws)));

    const segments = cwd.split(/[/\\]/).filter(Boolean);
    const projectName = segments[segments.length - 1] ?? "project";

    const welcome: WsPush = {
      type: "push",
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd,
        projectName,
        ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
        ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
      },
    };
    logOutgoingPush(welcome, 1);
    ws.send(JSON.stringify(welcome));

    ws.on("message", (raw) => {
      void runPromise(
        handleMessage(ws, raw).pipe(
          Effect.catch((error) => Effect.logError("Error handling message", error)),
        ),
      );
    });

    ws.on("close", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });

    ws.on("error", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });
  });

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
