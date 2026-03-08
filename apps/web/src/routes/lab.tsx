import { Outlet, createFileRoute } from "@tanstack/react-router";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import ThreadSidebar from "../components/Sidebar";
import { Sidebar, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const APP_SIDEBAR_WIDTH_STORAGE_KEY = "app_sidebar_width";
const APP_SIDEBAR_MIN_WIDTH = 14 * 16;
const APP_SIDEBAR_MAX_WIDTH = 28 * 16;

function LabRouteLayout() {
  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        side="left"
        collapsible="icon"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          storageKey: APP_SIDEBAR_WIDTH_STORAGE_KEY,
          minWidth: APP_SIDEBAR_MIN_WIDTH,
          maxWidth: APP_SIDEBAR_MAX_WIDTH,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      <DiffWorkerPoolProvider>
        <Outlet />
      </DiffWorkerPoolProvider>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/lab")({
  component: LabRouteLayout,
});
