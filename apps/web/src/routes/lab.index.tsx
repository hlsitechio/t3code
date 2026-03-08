import { Link, createFileRoute } from "@tanstack/react-router";
import { FlaskConicalIcon } from "lucide-react";

import { SidebarInset, SidebarTrigger } from "~/components/ui/sidebar";
import { Button } from "../components/ui/button";
import { isElectron } from "../env";

function LabIndexRouteView() {
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
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <FlaskConicalIcon className="size-4 text-foreground/70" />
              <span className="text-sm font-medium text-foreground">Lab Workspace</span>
            </div>
            <Button variant="outline" size="xs" render={<Link to="/" />}>
              Back to chat
            </Button>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <div className="text-xs text-muted-foreground/50">No active thread</div>

            <section className="rounded-3xl border border-border/70 bg-card/55 px-8 py-10 text-center shadow-2xl shadow-black/10 backdrop-blur-sm">
              <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-background/80 px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground/70">
                <FlaskConicalIcon className="size-3.5" />
                Experimental shell
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                Build the next UI here.
              </h1>
              <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
                The lab keeps the same projects, threads, and desktop runtime, but gives us a safe
                place to push layouts, browser workspaces, and new interaction ideas without
                disturbing the main chat route.
              </p>
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <Button variant="outline" render={<Link to="/" />}>
                  Open current app
                </Button>
                <Button variant="outline" render={<Link to="/" />}>
                  Pick a thread from the sidebar
                </Button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/lab/")({
  component: LabIndexRouteView,
});
