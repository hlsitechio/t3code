import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { APP_DISPLAY_NAME } from "./branding";
import { readNativeApi } from "./nativeApi";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProviderKey = "openai" | "anthropic" | "google" | "github";

type ProviderCredential = {
  provider: ProviderKey;
  method: "oauth" | "api-key";
  apiKey?: string;
  accessToken?: string;
  connectedAt: string;
};

type DesktopAuthSession = {
  signedInAt: string;
  providers: Record<ProviderKey, ProviderCredential | null>;
};

type DesktopAuthContextValue = {
  session: DesktopAuthSession | null;
  signIn: (session: DesktopAuthSession) => void;
  signOut: () => void;
  updateProvider: (provider: ProviderKey, credential: ProviderCredential | null) => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_STORAGE_KEY = "t3code.auth.session";

const PROVIDER_META: Record<
  ProviderKey,
  {
    name: string;
    brand: string;
    description: string;
    oauthLabel: string;
    oauthCommand: string;
    keyPlaceholder: string;
    keyDocsUrl: string;
    color: string;
  }
> = {
  openai: {
    name: "OpenAI",
    brand: "ChatGPT",
    description: "Use your ChatGPT Plus, Pro, or Team plan",
    oauthLabel: "Sign in with ChatGPT",
    oauthCommand: "codex login",
    keyPlaceholder: "sk-...",
    keyDocsUrl: "https://platform.openai.com/api-keys",
    color: "#10a37f",
  },
  anthropic: {
    name: "Anthropic",
    brand: "Claude",
    description: "Use your Claude Max, Pro, or Team plan",
    oauthLabel: "Sign in with Claude",
    oauthCommand: "claude login",
    keyPlaceholder: "sk-ant-...",
    keyDocsUrl: "https://console.anthropic.com/settings/keys",
    color: "#d97706",
  },
  google: {
    name: "Google",
    brand: "Gemini",
    description: "Use your Google AI or Vertex account",
    oauthLabel: "Sign in with Google",
    oauthCommand: "gemini login",
    keyPlaceholder: "AIza...",
    keyDocsUrl: "https://aistudio.google.com/apikey",
    color: "#4285f4",
  },
  github: {
    name: "GitHub",
    brand: "GitHub",
    description: "Git integration and Copilot access",
    oauthLabel: "Sign in with GitHub",
    oauthCommand: "gh auth login",
    keyPlaceholder: "ghp_...",
    keyDocsUrl: "https://github.com/settings/tokens",
    color: "#f0f6fc",
  },
};

const PROVIDER_ORDER: ProviderKey[] = ["openai", "anthropic", "google", "github"];

const DesktopAuthContext = createContext<DesktopAuthContextValue | null>(null);

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function readStoredSession(): DesktopAuthSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DesktopAuthSession;
    if (!parsed.signedInAt || !parsed.providers) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredSession(session: DesktopAuthSession | null): void {
  if (typeof window === "undefined") return;
  if (!session) {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

function createEmptySession(): DesktopAuthSession {
  return {
    signedInAt: new Date().toISOString(),
    providers: { openai: null, anthropic: null, google: null, github: null },
  };
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Provider icons
// ---------------------------------------------------------------------------

function OpenAIIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

function AnthropicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L16.906 20.48h-3.674l-1.343-3.461H5.017l-1.344 3.46H0l6.569-16.96zm2.327 5.045L6.286 14.78h5.218l-2.608-6.216z" />
    </svg>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

const PROVIDER_ICONS: Record<ProviderKey, typeof OpenAIIcon> = {
  openai: OpenAIIcon,
  anthropic: AnthropicIcon,
  google: GoogleIcon,
  github: GitHubIcon,
};

// ---------------------------------------------------------------------------
// OAuth sign-in button
// ---------------------------------------------------------------------------

function OAuthSignInButton({
  provider,
  credential,
  onOAuthStart,
  onApiKeyConnect,
  onDisconnect,
}: {
  provider: ProviderKey;
  credential: ProviderCredential | null;
  onOAuthStart: (provider: ProviderKey) => void;
  onApiKeyConnect: (provider: ProviderKey, key: string) => void;
  onDisconnect: (provider: ProviderKey) => void;
}) {
  const meta = PROVIDER_META[provider];
  const Icon = PROVIDER_ICONS[provider];
  const [showApiKey, setShowApiKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [oauthPending, setOauthPending] = useState(false);

  const isConnected = credential !== null;

  if (isConnected) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${meta.color}15` }}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white/90">{meta.brand}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
              <span className="h-1 w-1 rounded-full bg-emerald-400" />
              {credential.method === "oauth" ? "Signed in" : "API key"}
            </span>
          </div>
          <p className="text-[11px] text-zinc-600">
            {credential.method === "api-key" && credential.apiKey ? maskKey(credential.apiKey) : "Authenticated via browser"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onDisconnect(provider)}
          className="text-[11px] text-zinc-600 transition hover:text-red-400"
        >
          Disconnect
        </button>
      </div>
    );
  }

  if (showApiKey) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-zinc-400" />
          <span className="text-sm font-medium text-white/80">{meta.brand} API Key</span>
          <button
            type="button"
            onClick={() => { setShowApiKey(false); setKeyInput(""); }}
            className="ml-auto text-[11px] text-zinc-500 hover:text-white"
          >
            Back
          </button>
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && keyInput.trim().length >= 10) {
                onApiKeyConnect(provider, keyInput.trim());
                setKeyInput("");
                setShowApiKey(false);
              }
            }}
            placeholder={meta.keyPlaceholder}
            autoFocus
            className="h-8 min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-white outline-none placeholder:text-zinc-600 focus:border-white/20"
          />
          <button
            type="button"
            onClick={() => {
              if (keyInput.trim().length >= 10) {
                onApiKeyConnect(provider, keyInput.trim());
                setKeyInput("");
                setShowApiKey(false);
              }
            }}
            disabled={keyInput.trim().length < 10}
            className="h-8 rounded-lg bg-white px-3 text-xs font-medium text-black transition hover:bg-zinc-200 disabled:opacity-30"
          >
            Save
          </button>
        </div>
        <a
          href={meta.keyDocsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-zinc-500 transition hover:text-white"
        >
          Get an API key from {meta.name}
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => {
          setOauthPending(true);
          onOAuthStart(provider);
          // Reset pending state after a delay — the login opens in browser
          setTimeout(() => setOauthPending(false), 3000);
        }}
        disabled={oauthPending}
        className="group flex h-12 w-full items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 text-sm font-medium text-white/90 transition hover:border-white/[0.15] hover:bg-white/[0.06] disabled:opacity-60"
      >
        <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ backgroundColor: `${meta.color}18` }}>
          <Icon className="h-4 w-4" />
        </div>
        <span className="flex-1 text-left">
          {oauthPending ? "Opening browser..." : meta.oauthLabel}
        </span>
        <span className="text-[11px] text-zinc-600 group-hover:text-zinc-400">{meta.description}</span>
      </button>
      <button
        type="button"
        onClick={() => setShowApiKey(true)}
        className="self-end text-[11px] text-zinc-600 transition hover:text-zinc-400"
      >
        Use API key instead
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GitHub Device Flow modal
// ---------------------------------------------------------------------------

function GitHubDeviceFlowModal({
  onSuccess,
  onCancel,
}: {
  onSuccess: (token: string) => void;
  onCancel: () => void;
}) {
  const [userCode, setUserCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<"loading" | "pending" | "success" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const copyCode = useCallback(() => {
    if (!userCode) return;
    void navigator.clipboard.writeText(userCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [userCode]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      setStatus("error");
      setError("Desktop API not available.");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const device = await api.github.startDeviceFlow();
        if (cancelled) return;

        setUserCode(device.userCode);
        setStatus("pending");

        // Small delay so the user sees the code before the browser steals focus
        await new Promise((r) => setTimeout(r, 2000));
        if (cancelled) return;

        // Open the verification URL
        await api.shell.openExternal(device.verificationUri);

        // Poll for completion
        const result = await api.github.pollDeviceFlow({
          deviceCode: device.deviceCode,
          interval: device.interval,
          expiresIn: device.expiresIn,
        });

        if (cancelled) return;
        setStatus("success");
        onSuccess(result.accessToken);
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "Authentication failed.");
      }
    })();

    return () => { cancelled = true; };
  }, [onSuccess]);

  return (
    <div className="fixed inset-x-0 top-0 z-[100] flex justify-center p-3">
      <div className="w-full max-w-xl animate-slide-down rounded-xl border border-white/[0.1] bg-[#141417] shadow-2xl shadow-black/40">
        {status === "loading" ? (
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/10 border-t-white/60" />
            <span className="text-sm text-zinc-400">Connecting to GitHub...</span>
          </div>
        ) : null}

        {status === "pending" && userCode ? (
          <div className="flex items-center gap-3 px-4 py-3">
            <GitHubIcon className="h-5 w-5 shrink-0 text-white/70" />
            <span className="text-sm text-zinc-300">Your code:</span>
            <code className="rounded-md border border-white/[0.1] bg-white/[0.05] px-3 py-1 text-lg font-bold tracking-[0.25em] text-white">
              {userCode}
            </code>
            <button
              type="button"
              onClick={copyCode}
              className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:bg-white/[0.08] hover:text-white active:scale-95"
            >
              {copied ? (
                <>
                  <svg className="h-3.5 w-3.5 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z" />
                    <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z" />
                  </svg>
                  Copy
                </>
              )}
            </button>
            <div className="ml-auto flex items-center gap-2">
              <div className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
              <span className="text-xs text-zinc-500">Waiting...</span>
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="ml-1 rounded-md p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-white"
              title="Cancel"
            >
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>
        ) : null}

        {status === "success" ? (
          <div className="flex items-center gap-2 px-4 py-3">
            <svg className="h-5 w-5 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            <span className="text-sm font-medium text-emerald-400">GitHub connected!</span>
          </div>
        ) : null}

        {status === "error" ? (
          <div className="flex items-center gap-3 px-4 py-3">
            <svg className="h-5 w-5 shrink-0 text-red-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            <span className="text-sm text-red-400">{error}</span>
            <button
              type="button"
              onClick={onCancel}
              className="ml-auto rounded-md p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-white"
            >
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth shell
// ---------------------------------------------------------------------------

function AuthShell({ children }: PropsWithChildren) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#09090b] px-4 py-10 text-white sm:px-6">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-x-0 top-0 h-[500px] bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(120,119,198,0.12),transparent)]" />
      </div>
      <div className="relative w-full max-w-lg">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading screen
// ---------------------------------------------------------------------------

function AuthLoadingScreen() {
  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="h-12 w-12 animate-spin rounded-full border-2 border-white/10 border-t-white/70" />
        <div>
          <h2 className="text-lg font-medium text-white/90">Loading {APP_DISPLAY_NAME}</h2>
          <p className="mt-1 text-sm text-zinc-500">Restoring your workspace...</p>
        </div>
      </div>
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------
// Welcome / Sign-in screen
// ---------------------------------------------------------------------------

function AuthWelcomeScreen() {
  const auth = useDesktopAuth();
  const [localProviders, setLocalProviders] = useState<DesktopAuthSession["providers"]>({
    openai: null,
    anthropic: null,
    google: null,
    github: null,
  });
  const PROVIDER_LOGIN_URLS: Record<ProviderKey, string> = {
    openai: "https://platform.openai.com/login",
    anthropic: "https://console.anthropic.com",
    google: "https://aistudio.google.com",
    github: "https://github.com/login",
  };

  const handleOAuthStart = useCallback((provider: ProviderKey) => {
    const api = readNativeApi();
    if (!api) return;

    // Open the provider's login page in the default browser
    void api.shell.openExternal(PROVIDER_LOGIN_URLS[provider]);

    // Mark as connected via OAuth (the CLI tool stores the actual token)
    setLocalProviders((prev) => ({
      ...prev,
      [provider]: {
        provider,
        method: "oauth" as const,
        connectedAt: new Date().toISOString(),
      } satisfies ProviderCredential,
    }));
  }, []);

  const handleApiKeyConnect = useCallback((provider: ProviderKey, apiKey: string) => {
    setLocalProviders((prev) => ({
      ...prev,
      [provider]: {
        provider,
        method: "api-key" as const,
        apiKey,
        connectedAt: new Date().toISOString(),
      } satisfies ProviderCredential,
    }));
  }, []);

  const handleDisconnect = useCallback((provider: ProviderKey) => {
    setLocalProviders((prev) => ({
      ...prev,
      [provider]: null,
    }));
  }, []);

  const connectedCount = PROVIDER_ORDER.filter((p) => localProviders[p] !== null).length;

  const handleContinue = () => {
    auth.signIn({
      providers: localProviders,
      signedInAt: new Date().toISOString(),
    });
  };

  return (
    <AuthShell>
      <div className="flex flex-col gap-8">
        {/* Header */}
        <div className="text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04]">
            <svg className="h-7 w-7 text-white/80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to {APP_DISPLAY_NAME}</h1>
          <p className="mt-2 text-sm text-zinc-500">
            Sign in with your AI accounts to get started.
            <br />
            Your existing plans (ChatGPT Plus, Claude Max, etc.) work here.
          </p>
        </div>

        {/* Provider sign-in buttons */}
        <div className="flex flex-col gap-3">
          {PROVIDER_ORDER.map((provider) => (
            <OAuthSignInButton
              key={provider}
              provider={provider}
              credential={localProviders[provider]}
              onOAuthStart={handleOAuthStart}
              onApiKeyConnect={handleApiKeyConnect}
              onDisconnect={handleDisconnect}
            />
          ))}
        </div>

        {/* Continue */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleContinue}
            className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-white px-4 text-sm font-medium text-black transition hover:bg-zinc-200"
          >
            {connectedCount > 0
              ? `Get started`
              : "Skip — set up later in Settings"}
          </button>
        </div>

        {/* Footer */}
        <p className="text-center text-[11px] leading-5 text-zinc-600">
          Credentials are stored locally on this device and never shared.
          <br />
          You can also use CLI login (codex login, claude login) from the terminal.
        </p>
      </div>

    </AuthShell>
  );
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

export function AppAuthGate({ children }: PropsWithChildren) {
  const [isHydrated, setIsHydrated] = useState(false);
  const [session, setSession] = useState<DesktopAuthSession | null>(null);

  useEffect(() => {
    setSession(readStoredSession());
    setIsHydrated(true);
  }, []);

  const value = useMemo<DesktopAuthContextValue>(
    () => ({
      session,
      signIn(nextSession) {
        writeStoredSession(nextSession);
        setSession(nextSession);
      },
      signOut() {
        writeStoredSession(null);
        setSession(null);
      },
      updateProvider(provider, credential) {
        if (!session) return;
        const updated = {
          ...session,
          providers: { ...session.providers, [provider]: credential },
        };
        writeStoredSession(updated);
        setSession(updated);
      },
    }),
    [session],
  );

  return (
    <DesktopAuthContext.Provider value={value}>
      {!isHydrated ? <AuthLoadingScreen /> : null}
      {isHydrated && session ? children : null}
      {isHydrated && !session ? <AuthWelcomeScreen /> : null}
    </DesktopAuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks & types
// ---------------------------------------------------------------------------

export function useDesktopAuth(): DesktopAuthContextValue {
  const context = useContext(DesktopAuthContext);
  if (!context) {
    throw new Error("useDesktopAuth must be used inside AppAuthGate.");
  }
  return context;
}

export type { DesktopAuthSession, DesktopAuthContextValue, ProviderKey, ProviderCredential };
