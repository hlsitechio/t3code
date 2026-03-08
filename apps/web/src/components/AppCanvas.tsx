import type { ThreadCanvasState, ThreadId } from "@t3tools/contracts";
import { Code2Icon, EyeIcon, FileTextIcon, LoaderCircleIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  CANVAS_DEFAULT_TAB_OPTIONS,
  type CanvasDefaultTab,
  type CanvasPreviewDevice,
  useAppSettings,
} from "../appSettings";
import { ensureNativeApi } from "../nativeApi";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type CanvasTab = CanvasDefaultTab;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildCanvasPreviewDocument(state: ThreadCanvasState): string {
  const jsxFile = state.files.find((file) => file.path === "src/App.jsx") ?? state.files[0];
  const stylesFile = state.files.find((file) => file.path === "src/styles.css");
  const escapedTitle = escapeHtml(state.title);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapedTitle}</title>
    <style>
      html, body, #root { margin: 0; min-height: 100%; background: #09090b; }
      body { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #f8fafc; }
${stylesFile?.contents ?? ""}
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <script type="text/babel" data-presets="react">
${jsxFile?.contents ?? "function App(){ return <main /> }"}
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
    </script>
  </body>
</html>`;
}

function previewFrameClass(device: CanvasPreviewDevice): string {
  switch (device) {
    case "mobile":
      return "mx-auto h-full w-[390px] max-w-full";
    case "tablet":
      return "mx-auto h-full w-[820px] max-w-full";
    case "desktop":
    default:
      return "h-full w-full";
  }
}

const EMPTY_CANVAS_STATE = (threadId: ThreadId): ThreadCanvasState => ({
  threadId,
  title: "Canvas App",
  framework: "react",
  prompt: "",
  files: [],
  lastUpdatedAt: new Date(0).toISOString(),
});

export default function AppCanvas({ threadId }: { threadId: ThreadId }) {
  const api = ensureNativeApi();
  const { settings } = useAppSettings();
  const [canvasState, setCanvasState] = useState<ThreadCanvasState>(() => EMPTY_CANVAS_STATE(threadId));
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<CanvasTab>(settings.canvasDefaultTab);

  useEffect(() => {
    setActiveTab(settings.canvasDefaultTab);
  }, [settings.canvasDefaultTab]);

  useEffect(() => {
    let disposed = false;
    setIsLoading(true);
    void api.canvas
      .getState({ threadId })
      .then((state) => {
        if (!disposed) {
          setCanvasState(state);
        }
      })
      .finally(() => {
        if (!disposed) {
          setIsLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [api.canvas, threadId]);

  const previewDocument = useMemo(() => buildCanvasPreviewDocument(canvasState), [canvasState]);
  const visibleFile = canvasState.files[0] ?? null;

  return (
    <aside className="relative flex h-full min-h-0 w-[min(52vw,860px)] shrink-0 flex-col overflow-hidden border-l border-border bg-card">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-3 py-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{canvasState.title}</span>
            <Badge variant="outline" className="text-[10px] uppercase tracking-[0.14em]">
              {canvasState.framework}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground/70">
            Generated app canvas. Keep Lab for browsing and operator workflows.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {CANVAS_DEFAULT_TAB_OPTIONS.map((tab) => (
            <Button
              key={tab.value}
              type="button"
              variant={activeTab === tab.value ? "default" : "outline"}
              size="xs"
              onClick={() => setActiveTab(tab.value)}
            >
              {tab.value === "preview" ? <EyeIcon className="size-3.5" /> : null}
              {tab.value === "code" ? <Code2Icon className="size-3.5" /> : null}
              {tab.value === "brief" ? <FileTextIcon className="size-3.5" /> : null}
              <span>{tab.label}</span>
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() => {
              setIsLoading(true);
              void api.canvas.getState({ threadId }).then(setCanvasState).finally(() => setIsLoading(false));
            }}
          >
            {isLoading ? <LoaderCircleIcon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
          </Button>
        </div>
      </div>

      {activeTab === "preview" ? (
        <div className="min-h-0 flex-1 overflow-auto bg-background p-4">
          <div
            className={cn(
              "h-full min-h-[24rem] overflow-hidden rounded-[28px] border border-border/70 bg-background shadow-2xl",
              previewFrameClass(settings.canvasPreviewDevice),
            )}
          >
            <iframe title="Canvas preview" sandbox="allow-scripts" className="h-full w-full border-0 bg-white" srcDoc={previewDocument} />
          </div>
        </div>
      ) : null}

      {activeTab === "code" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] overflow-hidden">
          <div className="border-r border-border/70 bg-card/60 p-3">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">
              <SparklesIcon className="size-3.5" />
              Canvas files
            </div>
            <div className="flex flex-col gap-1">
              {canvasState.files.map((file) => (
                <div
                  key={file.path}
                  className={cn(
                    "rounded-xl border px-3 py-2 text-left",
                    visibleFile?.path === file.path ? "border-primary/60 bg-accent text-foreground" : "border-border/60 bg-card text-muted-foreground",
                  )}
                >
                  <div className="truncate text-sm font-medium">{file.path}</div>
                  <div className="text-xs uppercase tracking-[0.14em]">{file.language}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="min-h-0 overflow-auto bg-background p-4">
            {canvasState.files.map((file) => (
              <section key={file.path} className="mb-6 last:mb-0">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-foreground">{file.path}</h3>
                  <Badge variant="outline">{file.language}</Badge>
                </div>
                <pre className="overflow-x-auto rounded-2xl border border-border/70 bg-card/70 p-4 text-xs leading-6 text-foreground/90">
                  <code>{file.contents}</code>
                </pre>
              </section>
            ))}
          </div>
        </div>
      ) : null}

      {activeTab === "brief" ? (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <div className="rounded-3xl border border-border/70 bg-card/60 p-5">
            <div className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
              Canvas brief
            </div>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-muted-foreground/85">
              {canvasState.prompt.trim().length > 0
                ? canvasState.prompt
                : "No brief yet. Ask the agent to shape the canvas and it can write the brief, React files, and styles here."}
            </p>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

