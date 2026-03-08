import type { DesktopBrowserViewState, ThreadId } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ensureNativeApi } from "../nativeApi";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";

const EMPTY_BROWSER_STATE = (threadId: ThreadId): DesktopBrowserViewState => ({
  threadId,
  url: null,
  title: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isVisible: false,
  lastUpdatedAt: new Date(0).toISOString(),
});
const BROWSER_CANVAS_WIDTH_STORAGE_KEY = "lab_browser_canvas_width";
const BROWSER_CANVAS_DEFAULT_WIDTH = 720;
const BROWSER_CANVAS_MIN_WIDTH = 420;
const BROWSER_CANVAS_MAX_WIDTH = 1200;

function clampBrowserCanvasWidth(width: number): number {
  return Math.max(BROWSER_CANVAS_MIN_WIDTH, Math.min(BROWSER_CANVAS_MAX_WIDTH, width));
}

function readPersistedBrowserCanvasWidth(): number {
  if (typeof window === "undefined") {
    return BROWSER_CANVAS_DEFAULT_WIDTH;
  }
  const stored = Number(window.localStorage.getItem(BROWSER_CANVAS_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored)
    ? clampBrowserCanvasWidth(stored)
    : BROWSER_CANVAS_DEFAULT_WIDTH;
}

function browserBoundsForCanvas(options: {
  root: HTMLElement;
  toolbar: HTMLElement | null;
  status: HTMLElement | null;
}) {
  const rect = options.root.getBoundingClientRect();
  const toolbarHeight = options.toolbar?.offsetHeight ?? 0;
  const statusHeight = options.status?.offsetHeight ?? 0;
  return {
    x: rect.left,
    y: rect.top + toolbarHeight + statusHeight,
    width: rect.width,
    height: Math.max(0, rect.height - toolbarHeight - statusHeight),
  };
}

export default function BrowserCanvas({
  threadId,
  initialUrl,
  layout = "sidebar",
}: {
  threadId: ThreadId;
  initialUrl?: string | null;
  layout?: "sidebar" | "stacked" | "sheet";
}) {
  const api = ensureNativeApi();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [browserState, setBrowserState] = useState<DesktopBrowserViewState>(() =>
    EMPTY_BROWSER_STATE(threadId),
  );
  const [urlDraft, setUrlDraft] = useState("");
  const [isNavigating, setIsNavigating] = useState(false);
  const [canvasWidth, setCanvasWidth] = useState<number>(() => readPersistedBrowserCanvasWidth());
  const isSidebarLayout = layout === "sidebar";

  useEffect(() => {
    setBrowserState(EMPTY_BROWSER_STATE(threadId));
    setUrlDraft("");
  }, [threadId]);

  useEffect(() => {
    let disposed = false;
    void api.browser
      .attach(threadId)
      .then((state) => {
        if (disposed) return;
        setBrowserState(state);
        setUrlDraft(state.url ?? initialUrl ?? "");
        if (!state.url && initialUrl) {
          setIsNavigating(true);
          void api.browser
            .navigate(threadId, initialUrl)
            .then((nextState) => {
              if (!disposed) {
                setBrowserState(nextState);
                setUrlDraft(nextState.url ?? initialUrl);
              }
            })
            .catch((error) => {
              if (!disposed) {
                toastManager.add({
                  type: "error",
                  title: "Unable to open browser URL",
                  description: error instanceof Error ? error.message : "Unknown browser error.",
                });
              }
            })
            .finally(() => {
              if (!disposed) {
                setIsNavigating(false);
              }
            });
        }
      })
      .catch((error) => {
        if (!disposed) {
          toastManager.add({
            type: "error",
            title: "Browser canvas unavailable",
            description: error instanceof Error ? error.message : "Unknown browser error.",
          });
        }
      });

    const unsubscribe = api.browser.onState((state) => {
      if (state.threadId !== threadId || disposed) {
        return;
      }
      setBrowserState(state);
      setUrlDraft((current) => (document.activeElement instanceof HTMLInputElement ? current : (state.url ?? current)));
    });

    return () => {
      disposed = true;
      unsubscribe();
      void api.browser.setVisible(threadId, false).catch(() => undefined);
    };
  }, [api.browser, initialUrl, threadId]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    let disposed = false;
    const syncBounds = () => {
      if (disposed) return;
      const bounds = browserBoundsForCanvas({
        root,
        toolbar: toolbarRef.current,
        status: statusRef.current,
      });
      void api.browser
        .setVisible(threadId, true, bounds)
        .then((state) => {
          if (!disposed) {
            setBrowserState(state);
          }
        })
        .catch(() => undefined);
    };

    syncBounds();

    const observer = new ResizeObserver(() => {
      syncBounds();
    });
    observer.observe(root);
    if (toolbarRef.current) {
      observer.observe(toolbarRef.current);
    }
    if (statusRef.current) {
      observer.observe(statusRef.current);
    }
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
    };
  }, [api.browser, canvasWidth, threadId]);

  const statusLabel = useMemo(() => {
    if (browserState.loading || isNavigating) {
      return "Loading";
    }
    if (browserState.url) {
      return "Ready";
    }
    return "Idle";
  }, [browserState.loading, browserState.url, isNavigating]);

  const handleNavigate = async () => {
    setIsNavigating(true);
    try {
      const nextState = await api.browser.navigate(threadId, urlDraft);
      setBrowserState(nextState);
      setUrlDraft(nextState.url ?? urlDraft);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to navigate browser",
        description: error instanceof Error ? error.message : "Unknown browser error.",
      });
    } finally {
      setIsNavigating(false);
    }
  };

  const persistCanvasWidth = (width: number) => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(BROWSER_CANVAS_WIDTH_STORAGE_KEY, String(width));
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: canvasWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }
    const nextWidth = clampBrowserCanvasWidth(resizeState.startWidth - (event.clientX - resizeState.startX));
    setCanvasWidth(nextWidth);
  };

  const stopResize = (pointerId: number) => {
    if (resizeStateRef.current?.pointerId !== pointerId) {
      return;
    }
    resizeStateRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    persistCanvasWidth(canvasWidth);
  };

  useEffect(() => {
    return () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
  }, []);

  return (
    <aside
      ref={rootRef}
      className={
        layout === "stacked"
          ? "relative flex h-[min(46dvh,34rem)] min-h-[20rem] w-full shrink-0 flex-col overflow-hidden border-t border-border bg-card"
          : layout === "sheet"
            ? "relative flex h-[min(82dvh,52rem)] min-h-[24rem] w-full flex-col overflow-hidden bg-card"
            : "relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-border bg-card"
      }
      style={isSidebarLayout ? { width: `${canvasWidth}px` } : undefined}
    >
      {isSidebarLayout ? (
        <button
          type="button"
          aria-label="Resize browser canvas"
          title="Drag to resize browser canvas"
          className="absolute top-0 -left-2 z-20 h-full w-4 cursor-col-resize bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:bg-border/70 hover:after:bg-primary/70"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={(event) => {
            stopResize(event.pointerId);
          }}
          onPointerCancel={(event) => {
            stopResize(event.pointerId);
          }}
        />
      ) : null}
      <div
        ref={toolbarRef}
        className="z-10 flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2"
      >
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          disabled={!browserState.canGoBack}
          onClick={() => {
            void api.browser.goBack(threadId).then(setBrowserState).catch(() => undefined);
          }}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          disabled={!browserState.canGoForward}
          onClick={() => {
            void api.browser.goForward(threadId).then(setBrowserState).catch(() => undefined);
          }}
        >
          <ArrowRightIcon className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          onClick={() => {
            void api.browser.reload(threadId).then(setBrowserState).catch(() => undefined);
          }}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void handleNavigate();
          }}
        >
          <Input
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder="Enter a URL"
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" disabled={isNavigating} className="max-sm:w-full">
            Open
          </Button>
        </form>
        {browserState.url ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              void api.shell.openExternal(browserState.url ?? "").catch(() => undefined);
            }}
          >
            <ExternalLinkIcon className="size-4" />
          </Button>
        ) : null}
      </div>
      <div
        ref={statusRef}
        className="z-10 flex shrink-0 items-center gap-2 border-b border-border/80 bg-card px-3 py-1.5 text-xs text-muted-foreground"
      >
        {browserState.loading || isNavigating ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <GlobeIcon className="size-3.5" />
        )}
        <span>{statusLabel}</span>
        {browserState.title ? (
          <span className="min-w-0 truncate text-foreground/75">{browserState.title}</span>
        ) : null}
      </div>
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_50%)]" />
        {!browserState.url ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground/70">
            Open a URL to start a live browser session for this thread.
          </div>
        ) : null}
      </div>
    </aside>
  );
}
