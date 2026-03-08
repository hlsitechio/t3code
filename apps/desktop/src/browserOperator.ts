import type { BrowserView } from "electron";
import type {
  DesktopBrowserActInput,
  DesktopBrowserActionResult,
  DesktopBrowserExtractResult,
  DesktopBrowserObserveResult,
  DesktopBrowserViewState,
} from "@t3tools/contracts";

function nowIso(): string {
  return new Date().toISOString();
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildBrowserOperatorScript(payload: unknown): string {
  return `
(() => {
  const payload = ${escapeScriptJson(payload)};
  const normalize = (value) =>
    typeof value === "string" ? value.replace(/\\s+/g, " ").trim() : "";
  const lower = (value) => normalize(value).toLowerCase();
  const elementText = (element) => {
    const ariaLabel = normalize(element.getAttribute("aria-label"));
    const placeholder = normalize(element.getAttribute("placeholder"));
    const title = normalize(element.getAttribute("title"));
    const alt = normalize(element.getAttribute("alt"));
    const text = normalize(element.innerText || element.textContent || "");
    const value = "value" in element ? normalize(String(element.value || "")) : "";
    return [ariaLabel, placeholder, title, alt, value, text].filter(Boolean).join(" ").trim();
  };
  const labelTextForElement = (element) => {
    const ariaLabel = normalize(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const labelledBy = normalize(element.getAttribute("aria-labelledby"));
    if (labelledBy) {
      const label = labelledBy
        .split(/\\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => normalize(node.innerText || node.textContent || ""))
        .filter(Boolean)
        .join(" ");
      if (label) return label;
    }
    const id = normalize(element.id);
    if (id) {
      const explicit = document.querySelector(\`label[for="\${CSS.escape(id)}"]\`);
      const explicitText = normalize(explicit?.innerText || explicit?.textContent || "");
      if (explicitText) return explicitText;
    }
    const parentLabel = element.closest("label");
    return normalize(parentLabel?.innerText || parentLabel?.textContent || "");
  };
  const isEditableElement = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (element.isContentEditable) return true;
    if (element instanceof HTMLTextAreaElement) return true;
    if (element instanceof HTMLSelectElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    const type = lower(element.type || "text");
    return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
  };
  const describeElement = (element) => {
    const tag = lower(element.tagName);
    const role = normalize(element.getAttribute("role")) || null;
    const text = normalize(element.innerText || element.textContent || "") || null;
    const label = labelTextForElement(element) || null;
    const placeholder = normalize(element.getAttribute("placeholder")) || null;
    const name = normalize(element.getAttribute("name")) || null;
    const id = normalize(element.id) || null;
    const type = "type" in element ? normalize(String(element.type || "")) || null : null;
    const href = element instanceof HTMLAnchorElement ? normalize(element.href) || null : null;
    return {
      tag,
      role,
      text,
      label,
      placeholder,
      name,
      id,
      type,
      href,
      editable: isEditableElement(element),
    };
  };
  const interactiveSelector = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[contenteditable='true']",
    "[tabindex]"
  ].join(",");
  const collectInteractiveElements = () => {
    const seen = new Set();
    const elements = [];
    for (const node of document.querySelectorAll(interactiveSelector)) {
      if (!(node instanceof HTMLElement)) continue;
      if (seen.has(node)) continue;
      seen.add(node);
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      elements.push(node);
      if (elements.length >= 80) break;
    }
    return elements;
  };
  const scoreElement = (element, query, requireEditable) => {
    if (requireEditable && !isEditableElement(element)) return -1;
    const q = lower(query);
    if (!q) return -1;
    const description = describeElement(element);
    const candidates = [
      description.label,
      description.placeholder,
      description.text,
      description.name,
      description.id,
      description.href,
    ].filter(Boolean).map((value) => lower(value));
    let score = -1;
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate === q) score = Math.max(score, 100);
      else if (candidate.startsWith(q)) score = Math.max(score, 80);
      else if (candidate.includes(q)) score = Math.max(score, 60);
    }
    if (score < 0 && q.includes(".")) {
      const compact = q.replace(/^https?:\\/\\//, "").replace(/^www\\./, "");
      for (const candidate of candidates) {
        if (!candidate) continue;
        if (candidate.includes(compact)) score = Math.max(score, 40);
      }
    }
    return score;
  };
  const findBestElement = (query, options = {}) => {
    const elements = collectInteractiveElements();
    let bestElement = null;
    let bestScore = -1;
    for (const element of elements) {
      const score = scoreElement(element, query, options.requireEditable === true);
      if (score > bestScore) {
        bestScore = score;
        bestElement = element;
      }
    }
    return bestElement;
  };
  const setElementValue = (element, nextValue) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      descriptor?.set?.call(element, nextValue);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (element.isContentEditable) {
      element.focus();
      element.textContent = nextValue;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue, inputType: "insertText" }));
    }
  };
  const submitElement = (element) => {
    if (element instanceof HTMLElement) {
      const form = element.closest("form");
      if (form instanceof HTMLFormElement) {
        form.requestSubmit();
        return;
      }
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      active.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    }
  };
  const observationFor = (query) => {
    const elements = collectInteractiveElements().map(describeElement);
    const matched = query ? findBestElement(query) : null;
    return {
      url: window.location.href || null,
      title: document.title || null,
      elements,
      matchedElement: matched ? describeElement(matched) : null,
      documentText: normalize(document.body?.innerText || "").slice(0, 5000),
    };
  };
  const result = (() => {
    switch (payload.kind) {
      case "observe":
        return { ok: true, detail: "Observed page state.", observation: observationFor(payload.target) };
      case "extract":
        return {
          ok: true,
          detail: payload.query ? \`Extracted page text for "\${payload.query}".\` : "Extracted page text.",
          text: observationFor(payload.query).documentText,
        };
      case "act": {
        const action = payload.action;
        if (action.kind === "click") {
          const element = findBestElement(action.target);
          if (!element) return { ok: false, detail: \`Could not find "\${action.target}".\`, observation: observationFor(action.target) };
          element.click();
          return { ok: true, detail: \`Clicked "\${action.target}".\`, observation: observationFor(action.target) };
        }
        if (action.kind === "type") {
          const element = findBestElement(action.target, { requireEditable: true });
          if (!element) return { ok: false, detail: \`Could not find editable field "\${action.target}".\`, observation: observationFor(action.target) };
          if (!(element instanceof HTMLElement)) return { ok: false, detail: \`Target "\${action.target}" is not editable.\`, observation: observationFor(action.target) };
          element.focus();
          setElementValue(element, action.text);
          if (action.submit === true) submitElement(element);
          return { ok: true, detail: \`Entered text into "\${action.target}".\`, observation: observationFor(action.target) };
        }
        if (action.kind === "press") {
          const active = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
          active?.dispatchEvent(new KeyboardEvent("keydown", { key: action.key, bubbles: true }));
          active?.dispatchEvent(new KeyboardEvent("keyup", { key: action.key, bubbles: true }));
          if (action.key === "Enter" && active instanceof HTMLElement) submitElement(active);
          return { ok: true, detail: \`Pressed "\${action.key}".\`, observation: observationFor(null) };
        }
        if (action.kind === "scroll") {
          const amount = typeof action.amount === "number" && Number.isFinite(action.amount) ? Math.max(80, Math.floor(action.amount)) : 640;
          window.scrollBy({ top: action.direction === "down" ? amount : -amount, behavior: "smooth" });
          return { ok: true, detail: \`Scrolled \${action.direction}.\`, observation: observationFor(null) };
        }
        return { ok: false, detail: "Unsupported browser action.", observation: observationFor(null) };
      }
      default:
        return { ok: false, detail: "Unsupported browser operator request." };
    }
  })();
  return result;
})()
`;
}

async function executeOperatorScript<T>(view: BrowserView, payload: unknown): Promise<T> {
  return view.webContents.executeJavaScript(buildBrowserOperatorScript(payload), true) as Promise<T>;
}

export async function observeBrowserView(
  view: BrowserView,
  threadId: string,
  target?: string,
): Promise<DesktopBrowserObserveResult> {
  const result = await executeOperatorScript<{
    observation: Omit<DesktopBrowserObserveResult, "threadId" | "lastUpdatedAt">;
  }>(view, { kind: "observe", ...(target ? { target } : {}) });
  return {
    threadId,
    ...result.observation,
    lastUpdatedAt: nowIso(),
  };
}

export async function extractBrowserView(
  view: BrowserView,
  threadId: string,
  query?: string,
): Promise<DesktopBrowserExtractResult> {
  const result = await executeOperatorScript<{ text: string }>(view, {
    kind: "extract",
    ...(query ? { query } : {}),
  });
  return {
    threadId,
    url: view.webContents.getURL() || null,
    title: view.webContents.getTitle() || null,
    text: result.text,
    lastUpdatedAt: nowIso(),
  };
}

export async function actOnBrowserView(
  view: BrowserView,
  threadId: string,
  action: DesktopBrowserActInput,
  state: DesktopBrowserViewState,
): Promise<DesktopBrowserActionResult> {
  const result = await executeOperatorScript<{
    ok: boolean;
    detail: string;
    observation?: Omit<DesktopBrowserObserveResult, "threadId" | "lastUpdatedAt">;
  }>(view, {
    kind: "act",
    action,
  });
  return {
    threadId,
    ok: result.ok,
    detail: result.detail,
    state,
    ...(result.observation
      ? {
          observation: {
            threadId,
            ...result.observation,
            lastUpdatedAt: nowIso(),
          },
        }
      : {}),
  };
}
