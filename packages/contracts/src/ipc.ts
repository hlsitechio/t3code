import type {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import type {
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type {
  ServerConfig,
  ServerDetectCliInstallationsResult,
} from "./server";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type { ServerUpsertKeybindingInput, ServerUpsertKeybindingResult } from "./server";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "./orchestration";
import type { CanvasGetStateInput, CanvasUpsertStateInput, ThreadCanvasState } from "./canvas";
import { EditorId } from "./editor";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopBrowserViewState {
  threadId: string;
  url: string | null;
  title: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isVisible: boolean;
  lastUpdatedAt: string;
}

export interface DesktopBrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopBrowserObservedElement {
  tag: string;
  role: string | null;
  text: string | null;
  label: string | null;
  placeholder: string | null;
  name: string | null;
  id: string | null;
  type: string | null;
  href: string | null;
  editable: boolean;
}

export interface DesktopBrowserObserveResult {
  threadId: string;
  url: string | null;
  title: string | null;
  elements: DesktopBrowserObservedElement[];
  matchedElement: DesktopBrowserObservedElement | null;
  documentText: string;
  lastUpdatedAt: string;
}

export type DesktopBrowserActInput =
  | { kind: "click"; target: string }
  | { kind: "type"; target: string; text: string; submit?: boolean }
  | { kind: "press"; key: string }
  | { kind: "scroll"; direction: "up" | "down"; amount?: number };

export interface DesktopBrowserActionResult {
  threadId: string;
  ok: boolean;
  detail: string;
  state: DesktopBrowserViewState;
  observation?: DesktopBrowserObserveResult;
}

export interface DesktopBrowserExtractResult {
  threadId: string;
  url: string | null;
  title: string | null;
  text: string;
  lastUpdatedAt: string;
}

export interface DesktopBridge {
  getWsUrl: () => string | null;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  browserAttach: (threadId: string) => Promise<DesktopBrowserViewState>;
  browserSetVisible: (
    threadId: string,
    visible: boolean,
    bounds?: DesktopBrowserViewBounds,
  ) => Promise<DesktopBrowserViewState>;
  browserNavigate: (threadId: string, url: string) => Promise<DesktopBrowserViewState>;
  browserGoBack: (threadId: string) => Promise<DesktopBrowserViewState>;
  browserGoForward: (threadId: string) => Promise<DesktopBrowserViewState>;
  browserReload: (threadId: string) => Promise<DesktopBrowserViewState>;
  browserGetState: (threadId: string) => Promise<DesktopBrowserViewState>;
  browserObserve: (threadId: string, target?: string) => Promise<DesktopBrowserObserveResult>;
  browserAct: (threadId: string, action: DesktopBrowserActInput) => Promise<DesktopBrowserActionResult>;
  browserExtract: (threadId: string, query?: string) => Promise<DesktopBrowserExtractResult>;
  browserWait: (threadId: string, durationMs: number) => Promise<DesktopBrowserViewState>;
  onBrowserState: (listener: (state: DesktopBrowserViewState) => void) => () => void;
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
    write: (input: TerminalWriteInput) => Promise<void>;
    resize: (input: TerminalResizeInput) => Promise<void>;
    clear: (input: TerminalClearInput) => Promise<void>;
    restart: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
    close: (input: TerminalCloseInput) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  github: {
    startDeviceFlow: () => Promise<{
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      expiresIn: number;
      interval: number;
    }>;
    pollDeviceFlow: (input: {
      deviceCode: string;
      interval: number;
      expiresIn: number;
    }) => Promise<{
      accessToken: string;
      tokenType: string;
      scope: string;
    }>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
    runStackedAction: (input: GitRunStackedActionInput) => Promise<GitRunStackedActionResult>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    detectCliInstallations: () => Promise<ServerDetectCliInstallationsResult>;
  };
  canvas: {
    getState: (input: CanvasGetStateInput) => Promise<ThreadCanvasState>;
    upsertState: (input: CanvasUpsertStateInput) => Promise<ThreadCanvasState>;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationReadModel>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationEvent[]>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
  };
  browser: {
    attach: (threadId: string) => Promise<DesktopBrowserViewState>;
    setVisible: (
      threadId: string,
      visible: boolean,
      bounds?: DesktopBrowserViewBounds,
    ) => Promise<DesktopBrowserViewState>;
    navigate: (threadId: string, url: string) => Promise<DesktopBrowserViewState>;
    goBack: (threadId: string) => Promise<DesktopBrowserViewState>;
    goForward: (threadId: string) => Promise<DesktopBrowserViewState>;
    reload: (threadId: string) => Promise<DesktopBrowserViewState>;
    getState: (threadId: string) => Promise<DesktopBrowserViewState>;
    observe: (threadId: string, target?: string) => Promise<DesktopBrowserObserveResult>;
    act: (threadId: string, action: DesktopBrowserActInput) => Promise<DesktopBrowserActionResult>;
    extract: (threadId: string, query?: string) => Promise<DesktopBrowserExtractResult>;
    wait: (threadId: string, durationMs: number) => Promise<DesktopBrowserViewState>;
    onState: (listener: (state: DesktopBrowserViewState) => void) => () => void;
  };
}
