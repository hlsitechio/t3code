import { z } from "zod";

// ── WebSocket RPC Method Names ───────────────────────────────────────

export const WS_METHODS = {
  // State methods
  stateBootstrap: "state.bootstrap",
  stateListMessages: "state.listMessages",
  stateCatchUp: "state.catchUp",
  stateImportLegacyRendererState: "state.importLegacyRendererState",
  appSettingsGet: "appSettings.get",
  appSettingsUpdate: "appSettings.update",

  // Thread methods
  threadsCreate: "threads.create",
  threadsUpdate: "threads.update",
  threadsDelete: "threads.delete",
  threadsMarkVisited: "threads.markVisited",
  threadsUpdateTerminalState: "threads.updateTerminalState",
  threadsUpdateModel: "threads.updateModel",
  threadsUpdateTitle: "threads.updateTitle",
  threadsUpdateBranch: "threads.updateBranch",

  // Provider methods (mirrors NativeApi.providers)
  providersStartSession: "providers.startSession",
  providersSendTurn: "providers.sendTurn",
  providersInterruptTurn: "providers.interruptTurn",
  providersRespondToRequest: "providers.respondToRequest",
  providersStopSession: "providers.stopSession",
  providersListSessions: "providers.listSessions",
  providersListCheckpoints: "providers.listCheckpoints",
  providersGetCheckpointDiff: "providers.getCheckpointDiff",
  providersRevertToCheckpoint: "providers.revertToCheckpoint",

  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsUpdateScripts: "projects.updateScripts",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Git methods
  gitPull: "git.pull",
  gitStatus: "git.status",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverUpsertKeybinding: "server.upsertKeybinding",
} as const;

// ── Push Event Channels ──────────────────────────────────────────────

export const WS_CHANNELS = {
  providerEvent: "providers.event",
  stateEvent: "state.event",
  terminalEvent: "terminal.event",
  serverWelcome: "server.welcome",
} as const;

// ── Client → Server (request) ────────────────────────────────────────

export const wsRequestSchema = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export type WsRequest = z.infer<typeof wsRequestSchema>;

// ── Server → Client (response to request) ────────────────────────────

export const wsResponseSchema = z.object({
  id: z.string().min(1),
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string(),
    })
    .optional(),
});

export type WsResponse = z.infer<typeof wsResponseSchema>;

// ── Server → Client (push event) ─────────────────────────────────────

export const wsPushSchema = z.object({
  type: z.literal("push"),
  channel: z.string().min(1),
  data: z.unknown(),
});

export type WsPush = z.infer<typeof wsPushSchema>;

// ── Union of all server → client messages ─────────────────────────────

export type WsServerMessage = WsResponse | WsPush;

// ── Server welcome payload ───────────────────────────────────────────

export const wsWelcomePayloadSchema = z.object({
  cwd: z.string().min(1),
  projectName: z.string().min(1),
});

export type WsWelcomePayload = z.infer<typeof wsWelcomePayloadSchema>;
