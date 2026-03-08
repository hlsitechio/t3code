import { Schema } from "effect";
import { ProviderKind } from "./orchestration";

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  "claude-code": Schema.optional(Schema.Struct({})),
  "gemini-cli": Schema.optional(Schema.Struct({})),
  "github-copilot-cli": Schema.optional(Schema.Struct({})),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

type ModelOption = {
  readonly slug: string;
  readonly name: string;
};

export const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    { slug: "gpt-5.4", name: "GPT-5.4" },
    { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { slug: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
    { slug: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { slug: "gpt-5.2", name: "GPT-5.2" },
  ],
  "claude-code": [
    { slug: "claude-opus-4.1", name: "Claude Opus 4.1" },
    { slug: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { slug: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
  ],
  "gemini-cli": [
    { slug: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { slug: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ],
  "github-copilot-cli": [
    { slug: "gpt-5", name: "GPT-5" },
    { slug: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { slug: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ],
} as const satisfies Record<ProviderKind, readonly ModelOption[]>;
export type ModelOptionsByProvider = typeof MODEL_OPTIONS_BY_PROVIDER;

type BuiltInModelSlug = ModelOptionsByProvider[ProviderKind][number]["slug"];
export type ModelSlug = BuiltInModelSlug | (string & {});

export const DEFAULT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.4",
  "claude-code": "claude-sonnet-4.5",
  "gemini-cli": "gemini-2.5-pro",
  "github-copilot-cli": "gpt-5",
} as const satisfies Record<ProviderKind, ModelSlug>;

export const MODEL_SLUG_ALIASES_BY_PROVIDER = {
  codex: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  "claude-code": {
    opus: "claude-opus-4.1",
    sonnet: "claude-sonnet-4.5",
    haiku: "claude-haiku-4.5",
  },
  "gemini-cli": {
    pro: "gemini-2.5-pro",
    flash: "gemini-2.5-flash",
  },
  "github-copilot-cli": {
    "gpt-5-copilot": "gpt-5",
    sonnet: "claude-sonnet-4.5",
    gemini: "gemini-2.5-pro",
  },
} as const satisfies Record<ProviderKind, Record<string, ModelSlug>>;

export const REASONING_EFFORT_OPTIONS_BY_PROVIDER = {
  codex: CODEX_REASONING_EFFORT_OPTIONS,
  "claude-code": [],
  "gemini-cli": [],
  "github-copilot-cli": [],
} as const satisfies Record<ProviderKind, readonly CodexReasoningEffort[]>;

export const DEFAULT_REASONING_EFFORT_BY_PROVIDER = {
  codex: "high",
  "claude-code": null,
  "gemini-cli": null,
  "github-copilot-cli": null,
} as const satisfies Record<ProviderKind, CodexReasoningEffort | null>;
