import { ThreadId } from "@t3tools/contracts";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { FlaskConicalIcon } from "lucide-react";
import { Suspense, lazy, useEffect } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { Button } from "../components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";
import { isElectron } from "../env";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { cn } from "../lib/utils";

const LAB_STACKED_BROWSER_MEDIA_QUERY = "(max-width: 1500px)";
const ChatView = lazy(() => import("../components/ChatView"));
const BrowserCanvas = lazy(() => import("../components/BrowserCanvas"));

function LabThreadRouteView() {
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadExists = useComposerDraftStore(
    (store) => Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const shouldStackBrowser = useMediaQuery(LAB_STACKED_BROWSER_MEDIA_QUERY);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/lab", replace: true });
    }
  }, [navigate, routeThreadExists, threadsHydrated]);

  if (!threadsHydrated || !routeThreadExists) {
    return null;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <header className="border-b border-border px-3 sm:px-5">
          <div
            className={
              isElectron
                ? "drag-region flex h-[52px] items-center justify-between gap-3"
                : "flex items-center justify-between gap-3 py-3"
            }
          >
            <div className="flex items-center gap-2">
              <FlaskConicalIcon className="size-4 text-foreground/70" />
              <span className="text-sm font-medium text-foreground">Lab Workspace</span>
              <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
                Experimental
              </span>
            </div>
            <Button
              variant="outline"
              size="xs"
              render={<Link to="/$threadId" params={{ threadId }} />}
            >
              Back to chat
            </Button>
          </div>
        </header>
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1",
            shouldStackBrowser ? "flex-col" : "flex-row",
          )}
        >
          <div className="min-h-0 min-w-0 flex-1">
            <Suspense fallback={null}>
              <ChatView key={`lab:${threadId}`} threadId={threadId} mode="lab" />
            </Suspense>
          </div>
          {isElectron ? (
            <Suspense fallback={null}>
              <BrowserCanvas
                threadId={threadId}
                layout={shouldStackBrowser ? "stacked" : "sidebar"}
              />
            </Suspense>
          ) : (
            <aside
              className={cn(
                "flex shrink-0 items-center justify-center bg-card px-6 text-center text-sm text-muted-foreground/70",
                shouldStackBrowser
                  ? "min-h-[18rem] w-full border-t border-border"
                  : "h-full w-[min(48vw,760px)] border-l border-border",
              )}
            >
              Browser canvas is desktop-only. Use the Electron app to test the full lab workspace.
            </aside>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/lab/$threadId")({
  component: LabThreadRouteView,
});
