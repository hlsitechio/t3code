import type { DesktopBrowserActInput } from "@t3tools/contracts";

export type UiCommandIntent =
  | { type: "open-lab" }
  | { type: "open-browser" }
  | { type: "close-browser" }
  | { type: "open-canvas" }
  | { type: "close-canvas" }
  | { type: "navigate-browser"; target: string }
  | { type: "browser-act"; action: DesktopBrowserActInput };

const BROWSER_PRESS_KEY_ALIASES: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: " ",
  spacebar: " ",
  backspace: "Backspace",
  delete: "Delete",
  up: "ArrowUp",
  "arrow up": "ArrowUp",
  down: "ArrowDown",
  "arrow down": "ArrowDown",
  left: "ArrowLeft",
  "arrow left": "ArrowLeft",
  right: "ArrowRight",
  "arrow right": "ArrowRight",
};

function looksLikeDirectBrowserUrl(value: string): boolean {
  return (
    /^(?:https?:\/\/)/i.test(value) ||
    /^localhost(?::\d+)?(?:[/?#]|$)/i.test(value) ||
    /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#]|$)/.test(value) ||
    /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value)
  );
}

function sanitizeBrowserTarget(value: string): string {
  return value
    .trim()
    .replace(/\s*\.\s*/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ");
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const firstChar = trimmed[0];
  const lastChar = trimmed[trimmed.length - 1];
  if (
    (firstChar === `"` && lastChar === `"`) ||
    (firstChar === `'` && lastChar === `'`) ||
    (firstChar === "`" && lastChar === "`")
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeBrowserElementTarget(value: string): string | null {
  const normalized = stripWrappingQuotes(
    value
      .trim()
      .replace(/^(?:the|a|an)\s+/i, "")
      .replace(/\s+/g, " "),
  );
  return normalized.length > 0 ? normalized : null;
}

function parseBrowserActionIntent(input: string): DesktopBrowserActInput | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const typeMatch =
    /^(?:type|enter|write|fill(?:\s+in)?|input)\s+(.+?)\s+(?:in|into|inside)\s+(.+)$/i.exec(
      trimmed,
    );
  if (typeMatch?.[1] && typeMatch[2]) {
    const text = stripWrappingQuotes(typeMatch[1]);
    const target = normalizeBrowserElementTarget(typeMatch[2]);
    if (text.length > 0 && target) {
      return { kind: "type", text, target };
    }
  }

  const clickMatch = /^(?:click|tap|select)\s+(?:on\s+)?(.+)$/i.exec(trimmed);
  if (clickMatch?.[1]) {
    const target = normalizeBrowserElementTarget(clickMatch[1]);
    if (target) {
      return { kind: "click", target };
    }
  }

  const pressMatch = /^(?:press|hit|tap)\s+(.+)$/i.exec(trimmed);
  if (pressMatch?.[1]) {
    const rawKey = stripWrappingQuotes(pressMatch[1]).trim().toLowerCase();
    const key = BROWSER_PRESS_KEY_ALIASES[rawKey] ?? rawKey;
    if (key.length > 0) {
      return { kind: "press", key };
    }
  }

  const scrollMatch = /^(?:scroll)\s+(up|down)(?:\s+(\d+))?$/i.exec(trimmed);
  if (scrollMatch?.[1]) {
    return {
      kind: "scroll",
      direction: scrollMatch[1].toLowerCase() === "up" ? "up" : "down",
      ...(scrollMatch[2] ? { amount: Number.parseInt(scrollMatch[2], 10) } : {}),
    };
  }

  return null;
}

export function normalizeBrowserNavigationTarget(
  rawValue: string,
  options?: { allowBareHost?: boolean },
): string | null {
  const trimmed = sanitizeBrowserTarget(rawValue);
  if (trimmed.length === 0) {
    return null;
  }

  if (options?.allowBareHost && /^[a-z0-9-]+$/i.test(trimmed)) {
    try {
      return new URL(`https://www.${trimmed}.com`).toString();
    } catch {
      return null;
    }
  }

  if (!looksLikeDirectBrowserUrl(trimmed)) {
    return null;
  }

  const withProtocol =
    trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function parseBrowserNavigationIntent(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const directUrl = normalizeBrowserNavigationTarget(trimmed);
  if (directUrl) {
    return directUrl;
  }

  const prefixedMatch =
    /^(?:(?:navigate|go)\s+(?:to\s+|the\s+)?(?:browser\s+(?:to\s+)?)?|open\s+(?:(?:the\s+)?browser\s+(?:to\s+)?)?)(.+)$/i.exec(
      trimmed,
    );
  if (!prefixedMatch?.[1]) {
    return null;
  }

  const candidate = prefixedMatch[1]
    .trim()
    .replace(/^the\s+/i, "")
    .replace(/\s+(?:website|site|page|browser|canvas)$/i, "");
  return normalizeBrowserNavigationTarget(candidate, { allowBareHost: true });
}

export function parseUiCommandIntent(input: string): UiCommandIntent | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  if (
    /^(?:open|show|launch|go to)\s+(?:the\s+)?(?:lab|browser lab|canvas lab|lab workspace)\b/.test(
      normalized,
    ) ||
    normalized === "lab"
  ) {
    return { type: "open-lab" };
  }

  if (
    /^(?:open|show|launch)\s+(?:the\s+)?(?:browser|canvas browser|canva browser)\b/.test(
      normalized,
    )
  ) {
    return { type: "open-browser" };
  }

  if (
    /^(?:close|hide)\s+(?:the\s+)?(?:browser|canvas browser|canva browser)\b/.test(
      normalized,
    )
  ) {
    return { type: "close-browser" };
  }

  if (/^(?:open|show|launch)\s+(?:the\s+)?canvas\b/.test(normalized)) {
    return { type: "open-canvas" };
  }

  if (/^(?:close|hide)\s+(?:the\s+)?canvas\b/.test(normalized)) {
    return { type: "close-canvas" };
  }

  const browserAction = parseBrowserActionIntent(trimmed);
  if (browserAction) {
    return { type: "browser-act", action: browserAction };
  }

  const browserTarget = parseBrowserNavigationIntent(trimmed);
  if (!browserTarget) {
    return null;
  }

  return { type: "navigate-browser", target: browserTarget };
}


