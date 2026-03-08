import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

interface BrowserViewState {
  threadId: string;
  url: string | null;
  title: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isVisible: boolean;
  lastUpdatedAt: string;
}

interface BrowserObservedElement {
  tag: string;
  role: string | null;
  text: string | null;
  label: string | null;
  placeholder: string | null;
  name: string | null;
  id: string | null;
  type: string | null;
  href: string | null;
  editable: boolean;
}

interface BrowserObserveResult {
  state: BrowserViewState;
  observation: {
    threadId: string;
    url: string | null;
    title: string | null;
    elements: BrowserObservedElement[];
    matchedElement: BrowserObservedElement | null;
    documentText: string;
    lastUpdatedAt: string;
  };
  screenshotBase64: string | null;
}

interface BrowserExtractResult {
  state: BrowserViewState;
  extraction: {
    threadId: string;
    url: string | null;
    title: string | null;
    text: string;
    lastUpdatedAt: string;
  };
}

interface BrowserActionResult {
  threadId: string;
  ok: boolean;
  detail: string;
  state: BrowserViewState;
  observation?: BrowserObserveResult["observation"];
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
  throw new Error(`lab-browser-mcp requires the ${flag} argument.`);
}

const operatorUrl = requireFlag("--operator-url");
const operatorToken = requireFlag("--operator-token");
const threadId = requireFlag("--thread-id");

async function operatorCall<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(operatorUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${operatorToken}`,
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

function formatState(state: BrowserViewState): string {
  return JSON.stringify(
    {
      threadId: state.threadId,
      url: state.url,
      title: state.title,
      loading: state.loading,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      isVisible: state.isVisible,
      lastUpdatedAt: state.lastUpdatedAt,
    },
    null,
    2,
  );
}

function summarizeObservedElements(elements: BrowserObservedElement[]): string {
  if (elements.length === 0) {
    return "No interactive elements detected.";
  }

  return elements
    .slice(0, 25)
    .map((element, index) => {
      const parts = [
        element.label,
        element.text,
        element.placeholder,
        element.name,
        element.id,
      ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      const descriptor = parts.length > 0 ? parts.join(" | ") : "(unlabeled)";
      const role = element.role ?? element.tag;
      return `${index + 1}. ${role}: ${descriptor}`;
    })
    .join("\n");
}

const server = new McpServer({
  name: "t3code-lab-browser",
  version: "0.1.0",
});

server.registerTool(
  "browser_get_state",
  {
    description: "Read the current state of the T3 Code Lab browser for this thread.",
  },
  async () => {
    const state = await operatorCall<BrowserViewState>("browser.getState");
    return {
      content: [
        {
          type: "text",
          text: formatState(state),
        },
      ],
    };
  },
);

server.registerTool(
  "browser_goto",
  {
    description: "Navigate the T3 Code Lab browser to a URL.",
    inputSchema: {
      url: z.string().min(1).describe("The http or https URL to open."),
    },
  },
  async ({ url }) => {
    const state = await operatorCall<BrowserViewState>("browser.navigate", { url });
    return {
      content: [
        {
          type: "text",
          text: `Navigated the Lab browser.\n${formatState(state)}`,
        },
      ],
    };
  },
);

server.registerTool(
  "browser_observe",
  {
    description:
      "Observe the current Lab browser page. Returns page text, interactive elements, and a screenshot when available.",
    inputSchema: {
      target: z
        .string()
        .optional()
        .describe("Optional target to bias observation toward a specific element or label."),
    },
  },
  async ({ target }) => {
    const result = await operatorCall<BrowserObserveResult>("browser.observe", target ? { target } : {});
    const summary = [
      formatState(result.state),
      "",
      `Matched element: ${
        result.observation.matchedElement
          ? JSON.stringify(result.observation.matchedElement, null, 2)
          : "none"
      }`,
      "",
      "Interactive elements:",
      summarizeObservedElements(result.observation.elements),
      "",
      "Document text excerpt:",
      result.observation.documentText.slice(0, 6000),
    ].join("\n");

    return {
      content: [
        { type: "text", text: summary },
        ...(result.screenshotBase64
          ? [
              {
                type: "image" as const,
                data: result.screenshotBase64,
                mimeType: "image/png",
              },
            ]
          : []),
      ],
    };
  },
);

server.registerTool(
  "browser_click",
  {
    description: "Click a visible element in the Lab browser by fuzzy matching its label, text, or placeholder.",
    inputSchema: {
      target: z.string().min(1).describe("Element label, text, placeholder, or other identifying text."),
    },
  },
  async ({ target }) => {
    const result = await operatorCall<BrowserActionResult>("browser.act", {
      action: { kind: "click", target },
    });
    return {
      content: [
        {
          type: "text",
          text: `${result.detail}\n${formatState(result.state)}`,
        },
      ],
    };
  },
);

server.registerTool(
  "browser_type",
  {
    description: "Type text into an editable field in the Lab browser.",
    inputSchema: {
      target: z.string().min(1).describe("Editable field label, placeholder, or other identifying text."),
      text: z.string().describe("Text to enter."),
      submit: z.boolean().optional().describe("Submit the field or enclosing form after typing."),
    },
  },
  async ({ target, text, submit }) => {
    const result = await operatorCall<BrowserActionResult>("browser.act", {
      action: { kind: "type", target, text, ...(submit ? { submit: true } : {}) },
    });
    return {
      content: [
        {
          type: "text",
          text: `${result.detail}\n${formatState(result.state)}`,
        },
      ],
    };
  },
);

server.registerTool(
  "browser_press",
  {
    description: "Press a keyboard key in the Lab browser.",
    inputSchema: {
      key: z.string().min(1).describe("The key to press, for example Enter, Tab, Escape, ArrowDown."),
    },
  },
  async ({ key }) => {
    const result = await operatorCall<BrowserActionResult>("browser.act", {
      action: { kind: "press", key },
    });
    return {
      content: [
        {
          type: "text",
          text: `${result.detail}\n${formatState(result.state)}`,
        },
      ],
    };
  },
);

server.registerTool(
  "browser_scroll",
  {
    description: "Scroll the Lab browser viewport.",
    inputSchema: {
      direction: z.enum(["up", "down"]).describe("Scroll direction."),
      amount: z.number().int().positive().optional().describe("Optional scroll amount in pixels."),
    },
  },
  async ({ direction, amount }) => {
    const result = await operatorCall<BrowserActionResult>("browser.act", {
      action: { kind: "scroll", direction, ...(typeof amount === "number" ? { amount } : {}) },
    });
    return {
      content: [
        {
          type: "text",
          text: `${result.detail}\n${formatState(result.state)}`,
        },
      ],
    };
  },
);

server.registerTool(
  "browser_extract",
  {
    description: "Extract text from the current Lab browser page.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Optional extraction focus or question to guide the extraction."),
    },
  },
  async ({ query }) => {
    const result = await operatorCall<BrowserExtractResult>("browser.extract", query ? { query } : {});
    return {
      content: [
        {
          type: "text",
          text: `${formatState(result.state)}\n\n${result.extraction.text}`,
        },
      ],
    };
  },
);

server.registerTool(
  "browser_wait",
  {
    description: "Wait for the current Lab browser page to settle for a short duration.",
    inputSchema: {
      durationMs: z
        .number()
        .int()
        .min(0)
        .max(30000)
        .describe("How long to wait in milliseconds."),
    },
  },
  async ({ durationMs }) => {
    const state = await operatorCall<BrowserViewState>("browser.wait", { durationMs });
    return {
      content: [
        {
          type: "text",
          text: `Waited ${durationMs}ms.\n${formatState(state)}`,
        },
      ],
    };
  },
);

server.registerTool(
  "browser_back",
  {
    description: "Navigate back in the Lab browser history.",
  },
  async () => {
    const state = await operatorCall<BrowserViewState>("browser.goBack");
    return {
      content: [
        {
          type: "text",
          text: `Navigated back.\n${formatState(state)}`,
        },
      ],
    };
  },
);

server.registerTool(
  "browser_forward",
  {
    description: "Navigate forward in the Lab browser history.",
  },
  async () => {
    const state = await operatorCall<BrowserViewState>("browser.goForward");
    return {
      content: [
        {
          type: "text",
          text: `Navigated forward.\n${formatState(state)}`,
        },
      ],
    };
  },
);

server.registerTool(
  "browser_reload",
  {
    description: "Reload the current Lab browser page.",
  },
  async () => {
    const state = await operatorCall<BrowserViewState>("browser.reload");
    return {
      content: [
        {
          type: "text",
          text: `Reloaded the page.\n${formatState(state)}`,
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`t3code-lab-browser MCP ready for thread ${threadId}`);
}

main().catch((error) => {
  console.error("lab-browser-mcp failed:", error);
  process.exit(1);
});
