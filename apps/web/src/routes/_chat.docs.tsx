import { createFileRoute } from "@tanstack/react-router";
import { BookOpenIcon, ExternalLinkIcon } from "lucide-react";

import WorkspaceSurfaceActions from "../components/WorkspaceSurfaceActions";
import { isElectron } from "../env";
import { useWorkspaceSurfaceLaunchers } from "../hooks/useWorkspaceSurfaceLaunchers";
import { SidebarInset } from "~/components/ui/sidebar";

const documentationSections = [
  {
    title: "Getting Started",
    description: "Boot the desktop shell, authenticate, and open your first project or chat.",
  },
  {
    title: "Workspaces",
    description: "Use Chat, Lab, Canvas, and terminal surfaces without leaving the desktop app.",
  },
  {
    title: "Providers",
    description: "Track Codex readiness separately from your signed-in app session.",
  },
] as const;

function DocumentationPage() {
  const { codexStatus, openCanvas, openLab, openTerminal } = useWorkspaceSurfaceLaunchers();

  return (
    <SidebarInset className="min-h-screen bg-background text-foreground">
      {isElectron && (
        <div className="drag-region flex h-[60px] shrink-0 items-center justify-between gap-4 border-b border-border px-5">
          <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
            Documentation
          </span>
          <WorkspaceSurfaceActions
            codexStatus={codexStatus}
            className="no-drag-region"
            onToggleTerminal={() => {
              void openTerminal();
            }}
            onOpenLab={() => {
              void openLab();
            }}
            onToggleCanvas={() => {
              void openCanvas();
            }}
          />
        </div>
      )}
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-8 sm:px-8">
        <header className="space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card/70 px-3 py-1 text-[11px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            <BookOpenIcon className="size-3.5" />
            Documentation
          </div>
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              T3CODER(DEV) documentation
            </h1>
            <p className="max-w-3xl text-sm leading-7 text-muted-foreground/80 sm:text-base">
              This is the shell for docs. We can expand it later with setup guides, operator flows,
              terminal references, and Lab browser tooling docs.
            </p>
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          {documentationSections.map((section) => (
            <article
              key={section.title}
              className="rounded-3xl border border-border/70 bg-card/55 p-5 shadow-sm"
            >
              <h2 className="text-lg font-medium text-foreground">{section.title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground/80">
                {section.description}
              </p>
            </article>
          ))}
        </section>

        <section className="rounded-3xl border border-border/70 bg-card/55 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">More content next</h2>
              <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground/80">
                We can extend this page with API references, auth setup, Codex runtime docs, and
                operator controls once the shell structure is settled.
              </p>
            </div>
            <a
              href="https://developers.openai.com/codex/sdk/#app-server"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-2xl border border-border/70 px-4 py-2 text-sm font-medium text-foreground transition hover:bg-accent"
            >
              Codex app-server docs
              <ExternalLinkIcon className="size-4" />
            </a>
          </div>
        </section>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/docs")({
  component: DocumentationPage,
});
