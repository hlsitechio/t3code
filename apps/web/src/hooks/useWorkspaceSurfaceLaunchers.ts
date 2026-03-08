import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { useTerminalStateStore } from "../terminalStateStore";
import { useProjectOnboarding } from "./useProjectOnboarding";

export function useWorkspaceSurfaceLaunchers() {
  const navigate = useNavigate();
  const { ensureWorkspaceThread } = useProjectOnboarding();
  const setTerminalOpen = useTerminalStateStore((store) => store.setTerminalOpen);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());

  const codexStatus =
    serverConfigQuery.data?.providers.find((provider) => provider.provider === "codex") ?? null;

  const openTerminal = useCallback(async () => {
    const threadId = await ensureWorkspaceThread("chat");
    setTerminalOpen(threadId, true);
    await navigate({
      to: "/$threadId",
      params: { threadId },
    });
  }, [ensureWorkspaceThread, navigate, setTerminalOpen]);

  const openLab = useCallback(async () => {
    await ensureWorkspaceThread("lab");
  }, [ensureWorkspaceThread]);

  const openCanvas = useCallback(async () => {
    const threadId = await ensureWorkspaceThread("chat");
    await navigate({
      to: "/$threadId",
      params: { threadId },
      search: { canvas: "1" },
    });
  }, [ensureWorkspaceThread, navigate]);

  return {
    codexStatus,
    openCanvas,
    openLab,
    openTerminal,
  };
}
