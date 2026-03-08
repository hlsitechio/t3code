import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";
import { CheckIcon, CopyIcon } from "lucide-react";
import React, {
  Children,
  Suspense,
  isValidElement,
  use,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as prettier from "prettier/standalone";
import * as prettierPluginBabel from "prettier/plugins/babel";
import * as prettierPluginEstree from "prettier/plugins/estree";
import * as prettierPluginHtml from "prettier/plugins/html";
import * as prettierPluginMarkdown from "prettier/plugins/markdown";
import * as prettierPluginPostcss from "prettier/plugins/postcss";
import * as prettierPluginTypescript from "prettier/plugins/typescript";
import * as prettierPluginYaml from "prettier/plugins/yaml";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import { useTheme } from "../hooks/useTheme";
import { resolveMarkdownFileLinkTarget } from "../markdown-links";
import { readNativeApi } from "../nativeApi";
import { preferredTerminalEditor } from "../terminal-links";

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const MAX_PRETTIER_FORMAT_BYTES = 50_000;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
const formattedCodePromiseCache = new Map<string, Promise<string>>();

const PRETTIER_PARSER_BY_LANGUAGE: Record<string, string> = {
  css: "css",
  html: "html",
  javascript: "babel",
  js: "babel",
  json: "json",
  jsonc: "json",
  jsx: "babel",
  less: "less",
  markdown: "markdown",
  md: "markdown",
  scss: "scss",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  xml: "html",
  yaml: "yaml",
  yml: "yaml",
};
const PRETTIER_PLUGINS_BY_PARSER: Record<string, object[]> = {
  babel: [prettierPluginBabel, prettierPluginEstree],
  css: [prettierPluginPostcss],
  html: [prettierPluginHtml],
  json: [prettierPluginBabel, prettierPluginEstree],
  less: [prettierPluginPostcss],
  markdown: [prettierPluginMarkdown],
  scss: [prettierPluginPostcss],
  typescript: [prettierPluginTypescript, prettierPluginEstree],
  yaml: [prettierPluginYaml],
};

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  return match?.[1] ?? "text";
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== "code"
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function createFormatCacheKey(code: string, language: string): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

async function formatCodeWithPrettier(code: string, language: string): Promise<string> {
  if (code.length === 0 || code.length > MAX_PRETTIER_FORMAT_BYTES) {
    return code;
  }

  const parser = PRETTIER_PARSER_BY_LANGUAGE[language.toLowerCase()];
  if (!parser) {
    return code;
  }
  const plugins = PRETTIER_PLUGINS_BY_PARSER[parser] ?? [];

  if (plugins.length === 0) {
    return code;
  }

  try {
    return await prettier.format(code, {
      parser,
      plugins,
      tabWidth: 2,
      useTabs: false,
    });
  } catch {
    return code;
  }
}

function getFormattedCodePromise(code: string, language: string, isStreaming: boolean): Promise<string> {
  if (isStreaming) {
    return Promise.resolve(code);
  }

  const cacheKey = createFormatCacheKey(code, language);
  const cached = formattedCodePromiseCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = formatCodeWithPrettier(code, language).catch(() => code);
  formattedCodePromiseCache.set(cacheKey, promise);
  return promise;
}

function MarkdownCodeBlockChrome({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock">
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {children}
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const formattedCode = use(getFormattedCodePromise(code, language, isStreaming));
  const cacheKey = createHighlightCacheKey(formattedCode, language, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <MarkdownCodeBlockChrome code={formattedCode}>
        <div
          className="chat-markdown-shiki"
          dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
        />
      </MarkdownCodeBlockChrome>
    );
  }

  const highlighter = use(getHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(formattedCode, { lang: language, theme: themeName });
    } catch {
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(formattedCode, { lang: "text", theme: themeName });
    }
  }, [formattedCode, highlighter, language, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, formattedCode),
      );
    }
  }, [cacheKey, formattedCode, highlightedHtml, isStreaming]);

  return (
    <MarkdownCodeBlockChrome code={formattedCode}>
      <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
    </MarkdownCodeBlockChrome>
  );
}

function MarkdownCodeBlockFallback({
  code,
  children,
}: {
  code: string;
  children: ReactNode;
}) {
  return (
    <MarkdownCodeBlockChrome code={code}>
      {children}
    </MarkdownCodeBlockChrome>
  );
}

function ChatMarkdown({ text, cwd, isStreaming = false }: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownComponents = useMemo<Components>(
    () => ({
      a({ node: _node, href, ...props }) {
        const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
        if (!targetPath) {
          return <a {...props} href={href} target="_blank" rel="noreferrer" />;
        }

        return (
          <a
            {...props}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const api = readNativeApi();
              if (api) {
                void api.shell.openInEditor(targetPath, preferredTerminalEditor());
              } else {
                console.warn("Native API not found. Unable to open file in editor.");
              }
            }}
          />
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        return (
          <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
            <Suspense
              fallback={
                <MarkdownCodeBlockFallback code={codeBlock.code}>
                  <pre {...props}>{children}</pre>
                </MarkdownCodeBlockFallback>
              }
            >
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={diffThemeName}
                  isStreaming={isStreaming}
                />
            </Suspense>
          </CodeHighlightErrorBoundary>
        );
      },
    }),
    [cwd, diffThemeName, isStreaming],
  );

  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
