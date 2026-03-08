#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

interface ProjectAction {
  id: string;
  name: string;
  command: string;
  icon: "play" | "test" | "lint" | "configure" | "build" | "debug";
  runOnWorktreeCreate: boolean;
}

interface AppOperatorContextResult {
  thread: {
    id: string;
    title: string;
    model: string;
    runtimeMode: string;
    interactionMode: string;
  };
  project: {
    id: string;
    title: string;
    workspaceRoot: string;
    defaultModel: string | null;
    actions: ProjectAction[];
  };
  canvas: {
    title: string;
    framework: "react";
    fileCount: number;
    lastUpdatedAt: string;
  };
}

interface ActionMutationResult {
  projectId: string;
  action: ProjectAction;
  actionCount: number;
}

interface CanvasFile {
  path: string;
  language: "jsx" | "css" | "md";
  contents: string;
}

interface CanvasState {
  threadId: string;
  title: string;
  framework: "react";
  prompt: string;
  files: CanvasFile[];
  lastUpdatedAt: string;
}

type OperatorResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error: string };

function readFlag(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return null;
  }
  const next = process.argv[index + 1];
  return typeof next === "string" && next.trim().length > 0 ? next.trim() : null;
}

function requireFlag(flag: string): string {
  const value = readFlag(flag);
  if (value) {
    return value;
  }
  throw new Error(`app-operator-mcp requires the ${flag} argument.`);
}

const serverUrl = requireFlag("--server-url");
const serverToken = requireFlag("--server-token");
const threadId = requireFlag("--thread-id");

async function operatorCall<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(serverUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serverToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      method,
      params: {
        threadId,
        ...params,
      },
    }),
  });

  const payload = (await response.json()) as OperatorResponse<T>;
  if (!response.ok || !payload.ok) {
    const message = payload.ok ? `Operator request failed (${response.status}).` : payload.error;
    throw new Error(message);
  }
  return payload.result;
}

const server = new McpServer({
  name: "t3code-app-operator",
  version: "0.1.0",
});

server.registerTool(
  "app_get_context",
  {
    description:
      "Read the current T3 Code app context for this thread, including the current project and project actions.",
  },
  async () => {
    const result = await operatorCall<AppOperatorContextResult>("app.getContext");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "actions_list",
  {
    description: "List project actions available for the current thread's project.",
  },
  async () => {
    const result = await operatorCall<ProjectAction[]>("actions.list");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "actions_create",
  {
    description:
      "Create a new project action in T3 Code for the current thread's project. Use this instead of asking the user to fill the Add Action dialog manually.",
    inputSchema: {
      name: z.string().min(1).describe("Action name shown in the top bar and menus."),
      command: z.string().min(1).describe("Shell command to run for the action."),
      icon: z
        .enum(["play", "test", "lint", "configure", "build", "debug"])
        .optional()
        .describe("Optional action icon."),
      keybinding: z
        .string()
        .optional()
        .describe("Optional keybinding like mod+shift+t."),
      runOnWorktreeCreate: z
        .boolean()
        .optional()
        .describe("Whether this action should run automatically on worktree creation."),
    },
  },
  async ({ command, icon, keybinding, name, runOnWorktreeCreate }) => {
    const result = await operatorCall<ActionMutationResult>("actions.create", {
      command,
      ...(icon ? { icon } : {}),
      ...(keybinding ? { keybinding } : {}),
      name,
      ...(runOnWorktreeCreate !== undefined ? { runOnWorktreeCreate } : {}),
    });
    return {
      content: [
        {
          type: "text",
          text: `Created action ${result.action.name}.\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  },
);

server.registerTool(
  "canvas_get_state",
  {
    description:
      "Read the current thread canvas state, including React files and prompt, for the in-app Canvas surface.",
  },
  async () => {
    const result = await operatorCall<CanvasState>("canvas.getState");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "canvas_update",
  {
    description:
      "Update the current thread canvas used by T3 Code's Canvas surface. This is how the agent should create or reshape the generated app surface instead of treating Canvas like a browser tab.",
    inputSchema: {
      title: z.string().optional().describe("Optional canvas title."),
      prompt: z.string().optional().describe("Optional canvas brief or prompt."),
      files: z
        .array(
          z.object({
            path: z.string().min(1),
            language: z.enum(["jsx", "css", "md"]),
            contents: z.string(),
          }),
        )
        .optional()
        .describe("Optional full file list to replace the current canvas files."),
    },
  },
  async ({ files, prompt, title }) => {
    const result = await operatorCall<CanvasState>("canvas.update", {
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof prompt === "string" ? { prompt } : {}),
      ...(files ? { files } : {}),
    });
    return {
      content: [
        {
          type: "text",
          text: `Updated canvas ${result.title}.\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`t3code-app-operator MCP ready for thread ${threadId}`);
}

main().catch((error) => {
  console.error("app-operator-mcp failed:", error);
  process.exit(1);
});
