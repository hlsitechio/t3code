import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_RUNTIME_MODE,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { newCommandId, newMessageId, newProjectId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { toastManager } from "../components/ui/toast";
import { truncateTitle } from "../truncateTitle";

export function useProjectOnboarding(routeThreadId: ThreadId | null = null) {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const navigate = useNavigate();
  const getDraftThreadByProjectId = useComposerDraftStore((store) => store.getDraftThreadByProjectId);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const clearProjectDraftThreadId = useComposerDraftStore((store) => store.clearProjectDraftThreadId);

  const handleNewThread = useCallback(
    async (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ) => {
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread = getDraftThreadByProjectId(projectId);
      if (storedDraftThread) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(storedDraftThread.threadId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setProjectDraftThreadId(projectId, storedDraftThread.threadId);
        if (routeThreadId !== storedDraftThread.threadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        }
        return storedDraftThread.threadId;
      }

      clearProjectDraftThreadId(projectId);

      const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
      if (activeDraftThread && routeThreadId && activeDraftThread.projectId === projectId) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(routeThreadId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setProjectDraftThreadId(projectId, routeThreadId);
        return routeThreadId;
      }

      const threadId = newThreadId();
      setProjectDraftThreadId(projectId, threadId, {
        createdAt: new Date().toISOString(),
        branch: options?.branch ?? null,
        worktreePath: options?.worktreePath ?? null,
        envMode: options?.envMode ?? "local",
        runtimeMode: DEFAULT_RUNTIME_MODE,
      });
      await navigate({
        to: "/$threadId",
        params: { threadId },
      });
      return threadId;
    },
    [
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      navigate,
      routeThreadId,
      setDraftThreadContext,
      setProjectDraftThreadId,
    ],
  );

  const focusMostRecentThreadForProject = useCallback(
    async (projectId: ProjectId) => {
      const latestThread = threads
        .filter((thread) => thread.projectId === projectId)
        .toSorted((a, b) => {
          const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          if (byDate !== 0) return byDate;
          return b.id.localeCompare(a.id);
        })[0];
      if (!latestThread) return null;
      await navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
      return latestThread.id;
    },
    [navigate, threads],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string, options?: { openThread?: boolean }) => {
      const cwd = rawCwd.trim();
      if (!cwd) return null;
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API unavailable.");
      }

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        await focusMostRecentThreadForProject(existing.id);
        return { created: false as const, projectId: existing.id, projectName: existing.name, cwd };
      }

      const projectId = newProjectId();
      const title = cwd.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? cwd;
      await api.orchestration.dispatchCommand({
        type: "project.create",
        commandId: newCommandId(),
        projectId,
        title,
        workspaceRoot: cwd,
        defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
        createdAt: new Date().toISOString(),
      });
      if (options?.openThread !== false) {
        await handleNewThread(projectId);
      }
      return { created: true as const, projectId, projectName: title, cwd };
    },
    [focusMostRecentThreadForProject, handleNewThread, projects],
  );

  const pickFolderAndAddProject = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      throw new Error("Folder picker unavailable.");
    }
    const pickedPath = await api.dialogs.pickFolder();
    if (!pickedPath) {
      return null;
    }
    return addProjectFromPath(pickedPath);
  }, [addProjectFromPath]);

  const addProjectWithToast = useCallback(
    async (cwd: string) => {
      try {
        return await addProjectFromPath(cwd);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to add project",
          description:
            error instanceof Error ? error.message : "An error occurred while adding the project.",
        });
        return null;
      }
    },
    [addProjectFromPath],
  );

  const ensureWorkspaceProject = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      throw new Error("Native API unavailable.");
    }

    if (projects.length > 0) {
      const latestThread = threads.toSorted((a, b) => {
        const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        if (byDate !== 0) return byDate;
        return b.id.localeCompare(a.id);
      })[0];
      if (latestThread) {
        return latestThread.projectId;
      }
      return projects[0]!.id;
    }

    const serverConfig = await api.server.getConfig();
    const result = await addProjectFromPath(serverConfig.cwd, { openThread: false });
    if (!result) {
      throw new Error("Unable to create a default workspace project.");
    }
    const snapshot = await api.orchestration.getSnapshot();
    syncServerReadModel(snapshot);
    return result.projectId;
  }, [addProjectFromPath, projects, syncServerReadModel, threads]);

  const ensureWorkspaceThread = useCallback(
    async (surface: "chat" | "lab" = "chat") => {
      const projectId = await ensureWorkspaceProject();
      const draftThread = getDraftThreadByProjectId(projectId);
      if (draftThread) {
        await navigate({
          to: surface === "lab" ? "/lab/$threadId" : "/$threadId",
          params: { threadId: draftThread.threadId },
        });
        return draftThread.threadId;
      }

      const latestThread = threads
        .filter((thread) => thread.projectId === projectId)
        .toSorted((a, b) => {
          const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          if (byDate !== 0) return byDate;
          return b.id.localeCompare(a.id);
        })[0];
      if (latestThread) {
        await navigate({
          to: surface === "lab" ? "/lab/$threadId" : "/$threadId",
          params: { threadId: latestThread.id },
        });
        return latestThread.id;
      }

      const threadId = await handleNewThread(projectId);
      if (surface === "lab") {
        await navigate({
          to: "/lab/$threadId",
          params: { threadId },
        });
      }
      return threadId;
    },
    [
      ensureWorkspaceProject,
      getDraftThreadByProjectId,
      handleNewThread,
      navigate,
      threads,
    ],
  );

  const startConversationFromHome = useCallback(
    async (input: {
      text: string;
      model: string;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
      assistantDeliveryMode: "buffered" | "streaming";
      serviceTier?: "fast" | "flex" | null;
    }) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API unavailable.");
      }

      const projectId = await ensureWorkspaceProject();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const threadTitle = truncateTitle(input.text.trim()) || "New thread";

      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId,
        projectId,
        title: threadTitle,
        model: input.model,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt,
      });

      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: input.text,
          attachments: [],
        },
        provider: "codex",
        model: input.model,
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
        assistantDeliveryMode: input.assistantDeliveryMode,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdAt,
      });

      const snapshot = await api.orchestration.getSnapshot();
      syncServerReadModel(snapshot);
      await navigate({
        to: "/$threadId",
        params: { threadId },
      });
      return threadId;
    },
    [ensureWorkspaceProject, navigate, syncServerReadModel],
  );

  return {
    addProjectFromPath,
    addProjectWithToast,
    ensureWorkspaceProject,
    ensureWorkspaceThread,
    handleNewThread,
    pickFolderAndAddProject,
    startConversationFromHome,
  };
}
