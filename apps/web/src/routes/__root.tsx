import { Outlet, createRootRouteWithContext, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";

import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { isElectron } from "../env";
import { useNativeApi } from "../hooks/useNativeApi";
import { invalidateGitQueries } from "../lib/gitReactQuery";
import { hydratePersistedState } from "../persistenceSchema";
import { useStore } from "../store";
import { onServerWelcome } from "../wsNativeApi";
import { APP_DISPLAY_NAME } from "../branding";

const CURRENT_RENDERER_STATE_KEY = "t3code:renderer-state:v7";
const LEGACY_RENDERER_STATE_KEYS = [
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
});

function RootRouteView() {
  const api = useNativeApi();

  if (!api) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <StateSyncRouter />
        <BrowserDefaultProjectBootstrap />
        <Outlet />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function readLegacyRendererImportPayload() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const rawCurrent = window.localStorage.getItem(CURRENT_RENDERER_STATE_KEY);
    const legacyValues = LEGACY_RENDERER_STATE_KEYS.map((key) =>
      window.localStorage.getItem(key),
    );
    const rawLegacy = legacyValues.find((value) => value !== null) ?? null;
    const raw = rawCurrent ?? rawLegacy;
    if (!raw) {
      return null;
    }
    const rawCodethingV1 = window.localStorage.getItem("codething:renderer-state:v1");
    const hydrated = hydratePersistedState(raw, !rawCurrent && raw === rawCodethingV1);
    if (!hydrated) {
      return null;
    }

    return {
      projects: hydrated.projects.map((project) => ({
        id: project.id,
        name: project.name,
        cwd: project.cwd,
        scripts: project.scripts,
      })),
      threads: hydrated.threads.map((thread) => ({
        id: thread.id,
        codexThreadId: thread.codexThreadId,
        projectId: thread.projectId,
        title: thread.title,
        model: thread.model,
        terminalOpen: thread.terminalOpen,
        terminalHeight: thread.terminalHeight,
        terminalIds: thread.terminalIds,
        activeTerminalId: thread.activeTerminalId,
        terminalGroups: thread.terminalGroups,
        activeTerminalGroupId: thread.activeTerminalGroupId,
        messages: thread.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          ...(message.attachments
            ? {
                attachments: message.attachments.map((attachment) => ({
                  type: attachment.type,
                  id: attachment.id,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: attachment.sizeBytes,
                })),
              }
            : {}),
          createdAt: message.createdAt,
          streaming: message.streaming,
        })),
        createdAt: thread.createdAt,
        ...(thread.lastVisitedAt ? { lastVisitedAt: thread.lastVisitedAt } : {}),
        ...(thread.branch !== null ? { branch: thread.branch } : {}),
        ...(thread.worktreePath !== null ? { worktreePath: thread.worktreePath } : {}),
        turnDiffSummaries: thread.turnDiffSummaries,
      })),
    };
  } catch {
    return null;
  }
}

function clearLegacyRendererState(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(CURRENT_RENDERER_STATE_KEY);
    for (const key of LEGACY_RENDERER_STATE_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage cleanup failures.
  }
}

function StateSyncRouter() {
  const api = useNativeApi();
  const { dispatch } = useStore();
  const queryClient = useQueryClient();
  const activeAssistantItemRef = useRef<string | null>(null);
  const activeThreadId = useParams({
    strict: false,
    select: (params) => params.threadId,
  });
  const lastStateSeqRef = useRef(0);
  const stateQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let retryDelayMs = 500;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const bootstrap = async () => {
      try {
        const snapshot = await api.state.bootstrap();
        if (disposed) return;
        dispatch({
          type: "HYDRATE_FROM_SERVER",
          snapshot,
        });
        lastStateSeqRef.current = snapshot.lastStateSeq;

        const legacyPayload = readLegacyRendererImportPayload();
        if (!legacyPayload) {
          return;
        }
        const importResult = await api.state.importLegacyRendererState(legacyPayload);
        if (disposed) return;
        if (importResult.imported) {
          const refreshed = await api.state.bootstrap();
          if (disposed) return;
          dispatch({
            type: "HYDRATE_FROM_SERVER",
            snapshot: refreshed,
          });
          lastStateSeqRef.current = refreshed.lastStateSeq;
        }
        if (importResult.imported || importResult.alreadyImported) {
          clearLegacyRendererState();
        }
      } catch {
        if (disposed) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void bootstrap();
        }, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
      }
    };

    void bootstrap();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [api, dispatch]);

  useEffect(() => {
    if (!api) return;
    return api.state.onEvent((event) => {
      stateQueueRef.current = stateQueueRef.current
        .then(async () => {
          if (event.seq <= lastStateSeqRef.current) {
            return;
          }

          if (event.seq > lastStateSeqRef.current + 1) {
            const catchUp = await api.state.catchUp({ afterSeq: lastStateSeqRef.current });
            for (const missingEvent of catchUp.events) {
              if (missingEvent.seq <= lastStateSeqRef.current) continue;
              dispatch({
                type: "APPLY_STATE_EVENT",
                event: missingEvent,
              });
              lastStateSeqRef.current = missingEvent.seq;
            }
          }

          if (event.seq > lastStateSeqRef.current) {
            dispatch({
              type: "APPLY_STATE_EVENT",
              event,
            });
            lastStateSeqRef.current = event.seq;
          }
        })
        .catch(() => undefined);
    });
  }, [api, dispatch]);

  useEffect(() => {
    if (!api) return;
    return api.providers.onEvent((event) => {
      if (event.method === "turn/completed") {
        void invalidateGitQueries(queryClient);
      }
      if (event.method === "checkpoint/captured") {
        const payload = event.payload as { turnCount?: number } | undefined;
        const turnCount = payload?.turnCount;
        void queryClient.invalidateQueries({
          queryKey: ["providers", "checkpointDiff"] as const,
          predicate: (query) => {
            if (typeof turnCount !== "number") return true;
            return query.queryKey[5] === turnCount;
          },
        });
      }
      if (!activeThreadId) return;
      dispatch({
        type: "APPLY_EVENT",
        event,
        activeAssistantItemRef,
        activeThreadId,
      });
    });
  }, [activeThreadId, api, dispatch, queryClient]);

  useEffect(() => {
    if (!api || !activeThreadId) return;
    const visitedAt = new Date().toISOString();
    dispatch({
      type: "MARK_THREAD_VISITED",
      threadId: activeThreadId,
      visitedAt,
    });
    void api.threads
      .markVisited({
        threadId: activeThreadId,
        visitedAt,
      })
      .catch(() => undefined);
  }, [activeThreadId, api, dispatch]);

  useEffect(() => {
    if (!api) return;
    return api.terminal.onEvent((event) => {
      dispatch({
        type: "APPLY_TERMINAL_EVENT",
        event,
      });
    });
  }, [api, dispatch]);

  return null;
}

function BrowserDefaultProjectBootstrap() {
  const api = useNativeApi();
  const { state } = useStore();
  const createdRef = useRef(false);

  useEffect(() => {
    if (isElectron || !api || !state.threadsHydrated) {
      return;
    }

    return onServerWelcome((payload) => {
      if (createdRef.current) {
        return;
      }

      const existing = state.projects.find((project) => project.cwd === payload.cwd);
      if (existing) {
        createdRef.current = true;
        return;
      }

      createdRef.current = true;
      void api.projects.add({ cwd: payload.cwd }).catch(() => {
        createdRef.current = false;
      });
    });
  }, [api, state.projects, state.threadsHydrated]);

  return null;
}
