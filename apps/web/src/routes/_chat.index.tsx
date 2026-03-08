import { Link, createFileRoute } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BotIcon,
  ChevronDownIcon,
  FolderPlusIcon,
  LockIcon,
  LockOpenIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getDefaultReasoningEffort, getReasoningEffortOptions } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";

import { isElectron } from "../env";
import { useProjectOnboarding } from "../hooks/useProjectOnboarding";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../components/ui/menu";
import { Separator } from "../components/ui/separator";
import { SidebarTrigger } from "../components/ui/sidebar";
import { Textarea } from "../components/ui/textarea";
import {
  getAppModelOptions,
  resolveAppModelSelection,
  resolveAppServiceTier,
  shouldShowFastTierIcon,
  useAppSettings,
} from "../appSettings";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import { parseUiCommandIntent } from "../uiCommandIntents";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { useTerminalStateStore } from "../terminalStateStore";
import WorkspaceSurfaceActions from "../components/WorkspaceSurfaceActions";

interface HomeMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

function makeHomeMessage(role: HomeMessage["role"], text: string): HomeMessage {
  return {
    id: crypto.randomUUID(),
    role,
    text,
  };
}

function normalizeProjectPathCandidate(value: string): string | null {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  if (trimmed.length === 0) return null;
  if (
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("\\\\") ||
    /^~[\\/]/.test(trimmed) ||
    /^\.\.?([\\/]|$)/.test(trimmed) ||
    trimmed.startsWith("/")
  ) {
    return trimmed;
  }
  return null;
}

function extractProjectPathIntent(prompt: string): string | null {
  const directPath = normalizeProjectPathCandidate(prompt);
  if (directPath) return directPath;

  const patterns = [
    /^(?:create|add|open|import|load)(?:\s+(?:a\s+)?project)?(?:\s+(?:at|from|in))?\s+(.+)$/i,
    /^(?:create|add|open|import|load)\s+(.+?)\s+(?:as\s+)?project$/i,
    /^(?:project|workspace|repo)\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(prompt.trim());
    const candidate = match?.[1];
    if (!candidate) continue;
    const normalized = normalizeProjectPathCandidate(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function isProjectCreationIntent(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;
  return /\b(project|workspace|repo|folder)\b/i.test(trimmed) || /\b(create|add|open|import|load)\b/i.test(trimmed);
}

function ChatIndexRouteView() {
  const navigate = useNavigate();
  const projects = useStore((store) => store.projects);
  const { addProjectWithToast, ensureWorkspaceThread, pickFolderAndAddProject, startConversationFromHome } =
    useProjectOnboarding();
  const { settings } = useAppSettings();
  const setTerminalOpen = useTerminalStateStore((store) => store.setTerminalOpen);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [prompt, setPrompt] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  const [interactionMode, setInteractionMode] = useState(DEFAULT_INTERACTION_MODE);
  const [runtimeMode, setRuntimeMode] = useState(DEFAULT_RUNTIME_MODE);
  const [reasoningEffort, setReasoningEffort] = useState(() => getDefaultReasoningEffort("codex"));
  const [selectedModel, setSelectedModel] = useState(() =>
    resolveAppModelSelection("codex", settings.customCodexModels, null),
  );
  const [messages, setMessages] = useState<HomeMessage[]>(() => [
    makeHomeMessage(
      "assistant",
      "Start here. Ask me to open a project folder, create a new project workspace, or pick a folder and I’ll launch the first thread for it.",
    ),
  ]);

  const helperText = useMemo(() => {
    if (projects.length === 0) {
      return "No project loaded yet. Ask for one by path or let me browse for it.";
    }
    return "No active thread. Ask to open another project or start working in an existing one.";
  }, [projects.length]);
  const modelOptions = useMemo(
    () => getAppModelOptions("codex", settings.customCodexModels),
    [settings.customCodexModels],
  );
  const reasoningOptions = useMemo(() => getReasoningEffortOptions("codex"), []);
  const codexStatus = useMemo(
    () => serverConfigQuery.data?.providers.find((status) => status.provider === "codex") ?? null,
    [serverConfigQuery.data?.providers],
  );

  const appendMessage = (role: HomeMessage["role"], text: string) => {
    setMessages((current) => [...current, makeHomeMessage(role, text)]);
  };

  const runWorkspaceAction = async (action: () => Promise<void>) => {
    if (isWorking) return;
    setIsWorking(true);
    try {
      await action();
    } finally {
      setIsWorking(false);
    }
  };

  const openWorkspaceTerminal = async () => {
    await runWorkspaceAction(async () => {
      const threadId = await ensureWorkspaceThread("chat");
      setTerminalOpen(threadId, true);
    });
  };

  const openWorkspaceLab = async () => {
    await runWorkspaceAction(async () => {
      await ensureWorkspaceThread("lab");
    });
  };

  const openWorkspaceCanvas = async () => {
    await runWorkspaceAction(async () => {
      const threadId = await ensureWorkspaceThread("chat");
      await navigate({
        to: "/$threadId",
        params: { threadId },
        search: { canvas: "1" },
      });
    });
  };

  const submitPrompt = async () => {
    const nextPrompt = prompt.trim();
    if (!nextPrompt || isWorking) return;
    setPrompt("");
    appendMessage("user", nextPrompt);

    const explicitPath = extractProjectPathIntent(nextPrompt);
    const uiCommandIntent = isElectron ? parseUiCommandIntent(nextPrompt) : null;
    setIsWorking(true);
    try {
      if (uiCommandIntent) {
        if (
          uiCommandIntent.type === "open-lab" ||
          uiCommandIntent.type === "open-browser" ||
          uiCommandIntent.type === "navigate-browser"
        ) {
          appendMessage("assistant", "Opening Lab.");
          await navigate({ to: "/lab" });
          return;
        }

        if (uiCommandIntent.type === "close-browser") {
          appendMessage("assistant", "The browser canvas lives in Lab. Open Lab again when you want it.");
          return;
        }
      }

      if (explicitPath) {
        const result = await addProjectWithToast(explicitPath);
        if (result) {
          appendMessage(
            "assistant",
            result.created
              ? `Added ${result.projectName} and opened a fresh thread for it.`
              : `Opened the existing project ${result.projectName}.`,
          );
        }
        return;
      }

      if (isProjectCreationIntent(nextPrompt) && isElectron) {
        appendMessage("assistant", "Pick a folder and I’ll turn it into a project now.");
        const result = await pickFolderAndAddProject();
        if (result) {
          appendMessage(
            "assistant",
            result.created
              ? `Added ${result.projectName} and opened a fresh thread for it.`
              : `Opened the existing project ${result.projectName}.`,
          );
        } else {
          appendMessage("assistant", "Folder picking was cancelled. Give me a path or try Browse.");
        }
        return;
      }

      await startConversationFromHome({
        text: nextPrompt,
        model: selectedModel,
        runtimeMode,
        interactionMode,
        assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
        serviceTier: resolveAppServiceTier(settings.codexServiceTier),
      });
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground">Threads</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex min-h-[52px] shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-2">
          <span className="text-xs text-muted-foreground/50">Home</span>
          <div className="min-w-0">
            <WorkspaceSurfaceActions
              codexStatus={codexStatus}
              terminalDisabled={false}
              canvasDisabled={false}
              busy={isWorking}
              onToggleTerminal={() => {
                void openWorkspaceTerminal();
              }}
              onOpenLab={() => {
                void openWorkspaceLab();
              }}
              onToggleCanvas={() => {
                void openWorkspaceCanvas();
              }}
            />
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border/80 px-4 py-3 sm:px-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Workspace Home</p>
              <p className="text-xs text-muted-foreground/65">
                Chat stays available even before a thread exists.
              </p>
            </div>
            {isElectron ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (isWorking) return;
                  void (async () => {
                    setIsWorking(true);
                    try {
                      const result = await pickFolderAndAddProject();
                      if (result) {
                        appendMessage(
                          "assistant",
                          result.created
                            ? `Added ${result.projectName} and opened a fresh thread for it.`
                            : `Opened the existing project ${result.projectName}.`,
                        );
                      }
                    } finally {
                      setIsWorking(false);
                    }
                  })();
                }}
                disabled={isWorking}
              >
                <FolderPlusIcon className="size-4" />
                New project
              </Button>
            ) : (
              <Button variant="ghost" size="sm" render={<Link to="/lab" />}>
                Open lab
              </Button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-card/70 px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground/70">
                <SparklesIcon className="size-3.5" />
                Workspace Intake
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                Keep the chat alive before the first thread exists.
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground/75">{helperText}</p>
            </div>

            <div className="space-y-3">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`max-w-3xl rounded-2xl border px-4 py-3 text-sm leading-6 ${
                    message.role === "assistant"
                      ? "border-border/80 bg-card/70 text-foreground/90"
                      : "ml-auto border-primary/20 bg-primary/8 text-foreground"
                  }`}
                >
                  {message.text}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="border-t border-border/80 px-4 py-4 sm:px-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 rounded-[28px] border border-primary/40 bg-card/85 p-4 shadow-[0_0_0_1px_rgba(59,130,246,0.08)] backdrop-blur-sm">
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder='Try "open project G:\\my-app" or "create project from this folder"'
              className="min-h-28 border-none bg-transparent shadow-none before:hidden"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitPrompt();
                }
              }}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <Menu>
                  <MenuTrigger
                    render={
                      <Button variant="ghost" size="sm" className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/75 hover:text-foreground/85 sm:px-3" />
                    }
                  >
                    <span>{selectedModel}</span>
                    {shouldShowFastTierIcon(selectedModel, settings.codexServiceTier) ? (
                      <ZapIcon className="size-3.5 text-amber-500" />
                    ) : null}
                    <ChevronDownIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="start">
                    <MenuRadioGroup
                      value={selectedModel}
                      onValueChange={(value) => setSelectedModel(value)}
                    >
                      {modelOptions.map((option) => (
                        <MenuRadioItem key={option.slug} value={option.slug}>
                          <span>{option.name}</span>
                          {option.isCustom ? (
                            <Badge variant="outline" className="ml-2 px-1.5 py-0 text-[10px]">
                              custom
                            </Badge>
                          ) : null}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>

                <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                <Menu>
                  <MenuTrigger
                    render={
                      <Button variant="ghost" size="sm" className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/75 hover:text-foreground/85 sm:px-3" />
                    }
                  >
                    <span className="capitalize">{reasoningEffort}</span>
                    <ChevronDownIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="start">
                    <MenuRadioGroup
                      value={reasoningEffort}
                      onValueChange={(value) => {
                        if (value === "low" || value === "medium" || value === "high" || value === "extra-high") {
                          setReasoningEffort(value);
                        }
                      }}
                    >
                      {reasoningOptions.map((option) => (
                        <MenuRadioItem key={option} value={option}>
                          <span className="capitalize">{option}</span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>

                <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/75 hover:text-foreground/85 sm:px-3"
                  onClick={() => {
                    setInteractionMode((current) => (current === "plan" ? "default" : "plan"));
                  }}
                >
                  <BotIcon className="size-4" />
                  <span>{interactionMode === "plan" ? "Plan" : "Chat"}</span>
                </Button>

                <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/75 hover:text-foreground/85 sm:px-3"
                  onClick={() => {
                    setRuntimeMode((current) =>
                      current === "full-access" ? "approval-required" : "full-access",
                    );
                  }}
                >
                  {runtimeMode === "full-access" ? (
                    <LockOpenIcon className="size-4" />
                  ) : (
                    <LockIcon className="size-4" />
                  )}
                  <span>{runtimeMode === "full-access" ? "Full access" : "Supervised"}</span>
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {isElectron && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (isWorking) return;
                      void (async () => {
                        setIsWorking(true);
                        try {
                          const result = await pickFolderAndAddProject();
                          if (result) {
                            appendMessage(
                              "assistant",
                              result.created
                                ? `Added ${result.projectName} and opened a fresh thread for it.`
                                : `Opened the existing project ${result.projectName}.`,
                            );
                          }
                        } finally {
                          setIsWorking(false);
                        }
                      })();
                    }}
                    disabled={isWorking}
                  >
                    <FolderPlusIcon className="size-4" />
                    Browse folder
                  </Button>
                )}
                <span className="text-xs text-muted-foreground/65">
                  Projects open into a thread automatically.
                </span>
              </div>
              <Button onClick={() => void submitPrompt()} disabled={isWorking || prompt.trim().length === 0}>
                {isWorking ? "Working..." : "Send"}
                <ArrowRightIcon className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
