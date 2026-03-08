import { useCallback, useSyncExternalStore } from "react";
import { Option, Schema } from "effect";
import { type ProviderKind, type ProviderServiceTier } from "@t3tools/contracts";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export const APP_SERVICE_TIER_OPTIONS = [
  {
    value: "auto",
    label: "Automatic",
    description: "Use Codex defaults without forcing a service tier.",
  },
  {
    value: "fast",
    label: "Fast",
    description: "Request the fast service tier when the model supports it.",
  },
  {
    value: "flex",
    label: "Flex",
    description: "Request the flex service tier when the model supports it.",
  },
] as const;
export type AppServiceTier = (typeof APP_SERVICE_TIER_OPTIONS)[number]["value"];
export const CANVAS_DEFAULT_TAB_OPTIONS = [
  { value: "preview", label: "Preview" },
  { value: "code", label: "Code" },
  { value: "brief", label: "Brief" },
] as const;
export type CanvasDefaultTab = (typeof CANVAS_DEFAULT_TAB_OPTIONS)[number]["value"];
export const CANVAS_PREVIEW_DEVICE_OPTIONS = [
  { value: "desktop", label: "Desktop" },
  { value: "tablet", label: "Tablet" },
  { value: "mobile", label: "Mobile" },
] as const;
export type CanvasPreviewDevice = (typeof CANVAS_PREVIEW_DEVICE_OPTIONS)[number]["value"];
export const GITHUB_AUTH_MODE_OPTIONS = [
  { value: "gh-cli", label: "GitHub CLI" },
  { value: "token", label: "Personal Access Token" },
  { value: "oauth-device", label: "OAuth Device Flow" },
] as const;
export type GitHubAuthMode = (typeof GITHUB_AUTH_MODE_OPTIONS)[number]["value"];
const AppServiceTierSchema = Schema.Literals(["auto", "fast", "flex"]);
const CanvasDefaultTabSchema = Schema.Literals(["preview", "code", "brief"]);
const CanvasPreviewDeviceSchema = Schema.Literals(["desktop", "tablet", "mobile"]);
const GitHubAuthModeSchema = Schema.Literals(["gh-cli", "token", "oauth-device"]);
const MODELS_WITH_FAST_SUPPORT = new Set(["gpt-5.4"]);
const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  "claude-code": new Set(getModelOptions("claude-code").map((option) => option.slug)),
  "gemini-cli": new Set(getModelOptions("gemini-cli").map((option) => option.slug)),
  "github-copilot-cli": new Set(getModelOptions("github-copilot-cli").map((option) => option.slug)),
};

const AppSettingsSchema = Schema.Struct({
  codexBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  codexHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  canvasAutoOpenOnUpdate: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(true)),
  ),
  canvasDefaultTab: CanvasDefaultTabSchema.pipe(
    Schema.withConstructorDefault(() => Option.some("preview")),
  ),
  canvasPreviewDevice: CanvasPreviewDeviceSchema.pipe(
    Schema.withConstructorDefault(() => Option.some("desktop")),
  ),
  codexServiceTier: AppServiceTierSchema.pipe(Schema.withConstructorDefault(() => Option.some("auto"))),
  customCodexModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  githubEnabled: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(false))),
  githubAuthMode: GitHubAuthModeSchema.pipe(
    Schema.withConstructorDefault(() => Option.some("gh-cli")),
  ),
  githubToken: Schema.String.check(Schema.isMaxLength(8192)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  githubOwner: Schema.String.check(Schema.isMaxLength(256)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  githubRepo: Schema.String.check(Schema.isMaxLength(256)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  githubDefaultBaseBranch: Schema.String.check(Schema.isMaxLength(128)).pipe(
    Schema.withConstructorDefault(() => Option.some("main")),
  ),
  githubWorkflowNameFilter: Schema.String.check(Schema.isMaxLength(512)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  githubDefaultLabels: Schema.String.check(Schema.isMaxLength(1024)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  githubAutoLinkIssues: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  githubAutoReviewOnPr: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(false))),
  githubActionsAutoRerunFailed: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  githubSecurityScanOnPush: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  githubRequirePassingChecks: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(true)),
  ),
  githubCreateDraftPrByDefault: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  githubSidebarControllerEnabled: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(true)),
  ),
  githubCliPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  githubCliArgs: Schema.String.check(Schema.isMaxLength(1024)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  claudeCliPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  claudeCliArgs: Schema.String.check(Schema.isMaxLength(1024)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  geminiCliPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  geminiCliArgs: Schema.String.check(Schema.isMaxLength(1024)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
});
export type AppSettings = typeof AppSettingsSchema.Type;
export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

export function resolveAppServiceTier(serviceTier: AppServiceTier): ProviderServiceTier | null {
  return serviceTier === "auto" ? null : serviceTier;
}

export function shouldShowFastTierIcon(
  model: string | null | undefined,
  serviceTier: AppServiceTier,
): boolean {
  const normalizedModel = normalizeModelSlug(model);
  return (
    resolveAppServiceTier(serviceTier) === "fast" &&
    normalizedModel !== null &&
    MODELS_WITH_FAST_SUPPORT.has(normalizedModel)
  );
}

const DEFAULT_APP_SETTINGS = AppSettingsSchema.makeUnsafe({});

let listeners: Array<() => void> = [];
let cachedRawSettings: string | null | undefined;
let cachedSnapshot: AppSettings = DEFAULT_APP_SETTINGS;

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();
  const builtInModelSlugs = BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider];

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
    githubToken: settings.githubToken.trim(),
    githubOwner: settings.githubOwner.trim(),
    githubRepo: settings.githubRepo.trim(),
    githubDefaultBaseBranch: settings.githubDefaultBaseBranch.trim() || "main",
    githubWorkflowNameFilter: settings.githubWorkflowNameFilter.trim(),
    githubDefaultLabels: settings.githubDefaultLabels.trim(),
    githubCliPath: settings.githubCliPath.trim(),
    githubCliArgs: settings.githubCliArgs.trim(),
    claudeCliPath: settings.claudeCliPath.trim(),
    claudeCliArgs: settings.claudeCliArgs.trim(),
    geminiCliPath: settings.geminiCliPath.trim(),
    geminiCliArgs: settings.geminiCliArgs.trim(),
  };
}

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getModelOptions(provider).map(({ slug, name }) => ({
    slug,
    name,
    isCustom: false,
  }));
  const seen = new Set(options.map((option) => option.slug));

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel: string | null | undefined,
): string {
  const options = getAppModelOptions(provider, customModels, selectedModel);
  const trimmedSelectedModel = selectedModel?.trim();
  if (trimmedSelectedModel) {
    const direct = options.find((option) => option.slug === trimmedSelectedModel);
    if (direct) {
      return direct.slug;
    }

    const byName = options.find(
      (option) => option.name.toLowerCase() === trimmedSelectedModel.toLowerCase(),
    );
    if (byName) {
      return byName.slug;
    }
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (!normalizedSelectedModel) {
    return getDefaultModel(provider);
  }

  return (
    options.find((option) => option.slug === normalizedSelectedModel)?.slug ??
    getDefaultModel(provider)
  );
}

export function getSlashModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  query: string,
  selectedModel?: string | null,
): AppModelOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const options = getAppModelOptions(provider, customModels, selectedModel);
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) => {
    const searchSlug = option.slug.toLowerCase();
    const searchName = option.name.toLowerCase();
    return searchSlug.includes(normalizedQuery) || searchName.includes(normalizedQuery);
  });
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function parsePersistedSettings(value: string | null): AppSettings {
  if (!value) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    return normalizeAppSettings(Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(value));
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function getAppSettingsSnapshot(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS;
  }

  const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  if (raw === cachedRawSettings) {
    return cachedSnapshot;
  }

  cachedRawSettings = raw;
  cachedSnapshot = parsePersistedSettings(raw);
  return cachedSnapshot;
}

function persistSettings(next: AppSettings): void {
  if (typeof window === "undefined") return;

  const raw = JSON.stringify(next);
  try {
    if (raw !== cachedRawSettings) {
      window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, raw);
    }
  } catch {
    // Best-effort persistence only.
  }

  cachedRawSettings = raw;
  cachedSnapshot = next;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_SETTINGS_STORAGE_KEY) {
      emitChange();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getAppSettingsSnapshot,
    () => DEFAULT_APP_SETTINGS,
  );

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = normalizeAppSettings(
      Schema.decodeSync(AppSettingsSchema)({
        ...getAppSettingsSnapshot(),
        ...patch,
      }),
    );
    persistSettings(next);
    emitChange();
  }, []);

  const resetSettings = useCallback(() => {
    persistSettings(DEFAULT_APP_SETTINGS);
    emitChange();
  }, []);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}

