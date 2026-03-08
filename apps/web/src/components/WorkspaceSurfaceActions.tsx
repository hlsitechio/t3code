import type { ServerProviderStatus } from "@t3tools/contracts";
import { BotIcon, FlaskConicalIcon, GlobeIcon, TerminalIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Toggle } from "./ui/toggle";

function codexStatusMeta(status: ServerProviderStatus | null): {
  label: string;
  dotClassName: string;
} {
  if (!status) {
    return {
      label: "Checking",
      dotClassName: "bg-muted-foreground/40",
    };
  }

  if (status.status === "error" || !status.available || status.authStatus === "unauthenticated") {
    return {
      label: "Attention",
      dotClassName: "bg-rose-500",
    };
  }

  if (status.status === "warning" || status.authStatus === "unknown") {
    return {
      label: "Limited",
      dotClassName: "bg-amber-500",
    };
  }

  return {
    label: "Ready",
    dotClassName: "bg-emerald-500",
  };
}

interface WorkspaceSurfaceActionsProps {
  codexStatus: ServerProviderStatus | null;
  terminalOpen?: boolean;
  canvasOpen?: boolean;
  terminalDisabled?: boolean;
  canvasDisabled?: boolean;
  labDisabled?: boolean;
  busy?: boolean;
  showLabButton?: boolean;
  showCanvasButton?: boolean;
  onToggleTerminal?: (() => void) | undefined;
  onOpenLab?: (() => void) | undefined;
  onToggleCanvas?: (() => void) | undefined;
  className?: string;
}

export default function WorkspaceSurfaceActions({
  codexStatus,
  terminalOpen = false,
  canvasOpen = false,
  terminalDisabled = false,
  canvasDisabled = false,
  labDisabled = false,
  busy = false,
  showLabButton = true,
  showCanvasButton = true,
  onToggleTerminal,
  onOpenLab,
  onToggleCanvas,
  className,
}: WorkspaceSurfaceActionsProps) {
  const codexMeta = codexStatusMeta(codexStatus);

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center justify-end gap-2", className)}>
      <Badge variant="outline" className="h-7 gap-2 rounded-full px-2.5 text-[11px]">
        <BotIcon className="size-3.5 text-foreground/70" />
        <span>Codex</span>
        <span className={cn("size-1.5 rounded-full", codexMeta.dotClassName)} />
        <span className="text-muted-foreground/75">{codexMeta.label}</span>
      </Badge>

      {onToggleTerminal ? (
        <Toggle
          className="shrink-0 gap-1.5 px-2"
          pressed={terminalOpen}
          onPressedChange={() => onToggleTerminal()}
          aria-label="Toggle terminal"
          variant="outline"
          size="xs"
          disabled={terminalDisabled || busy}
        >
          <TerminalIcon className="size-3" />
          <span>Terminal</span>
        </Toggle>
      ) : null}

      {showLabButton && onOpenLab ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onOpenLab}
          disabled={labDisabled || busy}
        >
          <FlaskConicalIcon className="size-3.5" />
          <span>Lab</span>
        </Button>
      ) : null}

      {showCanvasButton && onToggleCanvas ? (
        <Toggle
          className="shrink-0 gap-1.5 px-2"
          pressed={canvasOpen}
          onPressedChange={() => onToggleCanvas()}
          aria-label="Toggle canvas"
          variant="outline"
          size="xs"
          disabled={canvasDisabled || busy}
        >
          <GlobeIcon className="size-3" />
          <span>Canvas</span>
        </Toggle>
      ) : null}
    </div>
  );
}
