import {
  type AppSettings as BackendAppSettings,
  appSettingsSchema as backendAppSettingsSchema,
  appSettingsUpdateInputSchema,
} from "@t3tools/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { z } from "zod";

import { readNativeApi } from "./session-logic";

const LOCAL_APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:local:v1";
const LEGACY_APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";

const localAppSettingsSchema = z.object({
  confirmThreadDelete: z.boolean().default(true),
});

const legacyAppSettingsSchema = backendAppSettingsSchema.extend({
  confirmThreadDelete: z.boolean().default(true),
});

const appSettingsSchema = backendAppSettingsSchema.extend({
  confirmThreadDelete: z.boolean().default(true),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

const DEFAULT_BACKEND_APP_SETTINGS: BackendAppSettings = backendAppSettingsSchema.parse({});
const DEFAULT_LOCAL_APP_SETTINGS = localAppSettingsSchema.parse({});
const DEFAULT_APP_SETTINGS: AppSettings = {
  ...DEFAULT_BACKEND_APP_SETTINGS,
  ...DEFAULT_LOCAL_APP_SETTINGS,
};

let listeners: Array<() => void> = [];
let cachedBackendSettings: BackendAppSettings = DEFAULT_BACKEND_APP_SETTINGS;
let cachedLocalSettings = DEFAULT_LOCAL_APP_SETTINGS;
let cachedLocalCacheKey: string | undefined;
let backendHydrationPromise: Promise<void> | null = null;
let backendHydrated = false;
let backendUpdateSequence = 0;

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function parseLegacySettings(value: string | null): z.infer<typeof legacyAppSettingsSchema> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return legacyAppSettingsSchema.parse(parsed);
  } catch {
    return null;
  }
}

function readLegacySettingsSnapshot(): z.infer<typeof legacyAppSettingsSchema> | null {
  if (typeof window === "undefined") {
    return null;
  }
  return parseLegacySettings(window.localStorage.getItem(LEGACY_APP_SETTINGS_STORAGE_KEY));
}

function readLocalSettingsSnapshot() {
  if (typeof window === "undefined") {
    return DEFAULT_LOCAL_APP_SETTINGS;
  }

  const rawLocal = window.localStorage.getItem(LOCAL_APP_SETTINGS_STORAGE_KEY);
  const rawLegacy = rawLocal === null ? window.localStorage.getItem(LEGACY_APP_SETTINGS_STORAGE_KEY) : null;
  const cacheKey = rawLocal !== null ? `local:${rawLocal}` : `legacy:${rawLegacy ?? ""}`;
  if (cacheKey === cachedLocalCacheKey) {
    return cachedLocalSettings;
  }

  if (rawLocal !== null) {
    try {
      const parsed = JSON.parse(rawLocal) as unknown;
      cachedLocalSettings = localAppSettingsSchema.parse(parsed);
    } catch {
      cachedLocalSettings = DEFAULT_LOCAL_APP_SETTINGS;
    }
  } else {
    const legacySettings = parseLegacySettings(rawLegacy);
    cachedLocalSettings = localAppSettingsSchema.parse({
      confirmThreadDelete: legacySettings?.confirmThreadDelete ?? DEFAULT_LOCAL_APP_SETTINGS.confirmThreadDelete,
    });
  }

  cachedLocalCacheKey = cacheKey;
  return cachedLocalSettings;
}

function persistLocalSettings(next: z.infer<typeof localAppSettingsSchema>): void {
  if (typeof window === "undefined") return;

  const normalized = localAppSettingsSchema.parse(next);
  const raw = JSON.stringify(normalized);

  try {
    window.localStorage.setItem(LOCAL_APP_SETTINGS_STORAGE_KEY, raw);
  } catch {
    // Best-effort persistence only.
  }

  cachedLocalSettings = normalized;
  cachedLocalCacheKey = `local:${raw}`;
}

function normalizeBackendSettings(value: unknown): BackendAppSettings {
  const parsed = backendAppSettingsSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  return DEFAULT_BACKEND_APP_SETTINGS;
}

async function hydrateBackendSettings(): Promise<void> {
  if (typeof window === "undefined" || backendHydrated) {
    return;
  }
  if (backendHydrationPromise) {
    await backendHydrationPromise;
    return;
  }

  backendHydrationPromise = (async () => {
    const api = readNativeApi();
    if (!api?.appSettings || typeof api.appSettings.get !== "function") {
      backendHydrated = true;
      return;
    }

    const legacySettings = readLegacySettingsSnapshot();
    let next = normalizeBackendSettings(await api.appSettings.get());
    const migrationPatch = appSettingsUpdateInputSchema.parse({
      ...(next.codexBinaryPath.length === 0 && legacySettings?.codexBinaryPath
        ? { codexBinaryPath: legacySettings.codexBinaryPath }
        : {}),
      ...(next.codexHomePath.length === 0 && legacySettings?.codexHomePath
        ? { codexHomePath: legacySettings.codexHomePath }
        : {}),
    });
    const hasMigrationPatch =
      migrationPatch.codexBinaryPath !== undefined || migrationPatch.codexHomePath !== undefined;
    if (hasMigrationPatch) {
      next = normalizeBackendSettings(await api.appSettings.update(migrationPatch));
    }

    cachedBackendSettings = next;
    backendHydrated = true;

    if (legacySettings) {
      persistLocalSettings({
        confirmThreadDelete: legacySettings.confirmThreadDelete,
      });
      try {
        window.localStorage.removeItem(LEGACY_APP_SETTINGS_STORAGE_KEY);
      } catch {
        // Best-effort legacy cleanup only.
      }
    }

    emitChange();
  })()
    .catch(() => undefined)
    .finally(() => {
      backendHydrationPromise = null;
    });

  await backendHydrationPromise;
}

export function getAppSettingsSnapshot(): AppSettings {
  const localSettings = readLocalSettingsSnapshot();
  return appSettingsSchema.parse({
    ...cachedBackendSettings,
    ...localSettings,
  });
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === LOCAL_APP_SETTINGS_STORAGE_KEY ||
      event.key === LEGACY_APP_SETTINGS_STORAGE_KEY
    ) {
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
  const settings = useSyncExternalStore(subscribe, getAppSettingsSnapshot, () => DEFAULT_APP_SETTINGS);

  useEffect(() => {
    void hydrateBackendSettings();
  }, []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const parsedPatch = appSettingsSchema.partial().parse(patch);
    let didChange = false;

    if (parsedPatch.confirmThreadDelete !== undefined) {
      persistLocalSettings({
        ...readLocalSettingsSnapshot(),
        confirmThreadDelete: parsedPatch.confirmThreadDelete,
      });
      didChange = true;
    }

    const backendPatch = appSettingsUpdateInputSchema.parse({
      ...(parsedPatch.codexBinaryPath !== undefined
        ? { codexBinaryPath: parsedPatch.codexBinaryPath }
        : {}),
      ...(parsedPatch.codexHomePath !== undefined ? { codexHomePath: parsedPatch.codexHomePath } : {}),
    });
    const hasBackendPatch =
      backendPatch.codexBinaryPath !== undefined || backendPatch.codexHomePath !== undefined;
    if (hasBackendPatch) {
      const previous = cachedBackendSettings;
      const optimisticNext = backendAppSettingsSchema.parse({
        ...cachedBackendSettings,
        ...backendPatch,
      });
      cachedBackendSettings = optimisticNext;
      backendHydrated = true;
      didChange = true;

      const updateSequence = ++backendUpdateSequence;
      const api = readNativeApi();
      if (api?.appSettings && typeof api.appSettings.update === "function") {
        void api.appSettings
          .update(backendPatch)
          .then((response) => {
            if (updateSequence !== backendUpdateSequence) return;
            cachedBackendSettings = normalizeBackendSettings(response);
            emitChange();
          })
          .catch(() => {
            if (updateSequence !== backendUpdateSequence) return;
            cachedBackendSettings = previous;
            emitChange();
          });
      }
    }

    if (didChange) {
      emitChange();
    }
  }, []);

  const resetSettings = useCallback(() => {
    updateSettings(DEFAULT_APP_SETTINGS);
  }, [updateSettings]);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}
