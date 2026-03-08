import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type DesktopAuthSession = {
  email: string;
  signedInAt: string;
};

type DesktopAuthContextValue = {
  session: DesktopAuthSession | null;
  signIn: (session: DesktopAuthSession) => void;
  signOut: () => void;
};

const AUTH_STORAGE_KEY = "t3coder.dev.auth.session";
const CODE_LENGTH = 6;

const DesktopAuthContext = createContext<DesktopAuthContextValue | null>(null);

function readStoredSession(): DesktopAuthSession | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue) as Partial<DesktopAuthSession>;
    if (typeof parsed.email !== "string" || typeof parsed.signedInAt !== "string") {
      return null;
    }

    return {
      email: parsed.email,
      signedInAt: parsed.signedInAt,
    };
  } catch {
    return null;
  }
}

function writeStoredSession(session: DesktopAuthSession | null): void {
  if (typeof window === "undefined") {
    return;
  }

  if (!session) {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

function generateVerificationCode(): string {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  const randomValue = values.at(0) ?? 0;
  return String(randomValue % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, "0");
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function AuthShell({
  eyebrow,
  title,
  description,
  children,
}: PropsWithChildren<{
  eyebrow: string;
  title: string;
  description: string;
}>) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-blue-500)_18%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-6xl overflow-hidden rounded-[30px] border border-border/80 bg-card/90 shadow-2xl shadow-black/20 backdrop-blur-md">
        <div className="grid gap-0 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="border-b border-border/70 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--background)_82%,var(--color-black))_0%,color-mix(in_srgb,var(--background)_92%,var(--color-black))_100%)] p-8 lg:border-r lg:border-b-0 lg:p-12">
            <p className="text-[11px] font-semibold tracking-[0.24em] text-muted-foreground uppercase">
              {eyebrow}
            </p>
            <h1 className="mt-4 max-w-xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              {title}
            </h1>
            <p className="mt-5 max-w-xl text-base leading-8 text-muted-foreground/80">
              {description}
            </p>
            <div className="mt-10 grid gap-3 text-sm text-muted-foreground/80">
              <div className="rounded-2xl border border-border/70 bg-background/55 px-4 py-3">
                Codex stays visible and ready in the shell.
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/55 px-4 py-3">
                Terminal opens under chat instead of leaving the workspace.
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/55 px-4 py-3">
                Lab and Canvas remain first-class surfaces in the same desktop app.
              </div>
            </div>
          </div>
          <div className="flex items-center justify-center bg-[#050505] p-6 lg:p-10">{children}</div>
        </div>
      </section>
    </div>
  );
}

function ChatBubble({
  role,
  children,
}: PropsWithChildren<{
  role: "assistant" | "user";
}>) {
  const alignment = role === "assistant" ? "items-start" : "items-end";
  const bubbleClassName =
    role === "assistant"
      ? "border border-white/10 bg-[#0d0d11] text-white"
      : "bg-white text-black";

  return (
    <div className={`flex flex-col ${alignment}`}>
      <div className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-7 shadow-sm ${bubbleClassName}`}>
        {children}
      </div>
    </div>
  );
}

function AuthLoadingScreen() {
  return (
    <AuthShell
      eyebrow="Authentication"
      title="Checking your desktop session."
      description="Loading T3CODER(DEV), restoring your local sign-in state, and preparing Codex, terminal, Lab, and Canvas."
    >
      <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,#0b0b0d_0%,#050505_100%)] p-3 shadow-[0_20px_80px_rgba(0,0,0,0.45)]">
        <div className="rounded-[24px] border border-white/10 bg-black/40 p-7 text-white">
          <p className="text-[11px] font-semibold tracking-[0.22em] text-zinc-500 uppercase">
            Loading
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight">Preparing your workspace.</h2>
          <p className="mt-3 text-sm leading-7 text-zinc-400">
            Restoring session state and booting the desktop shell.
          </p>
          <div className="mt-8 h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-white/70" />
          </div>
        </div>
      </div>
    </AuthShell>
  );
}

function AuthSignInScreen() {
  const auth = useDesktopAuth();
  const [email, setEmail] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [verificationCode, setVerificationCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  const stage = pendingEmail && verificationCode ? "code" : "email";

  const resetFlow = () => {
    setPendingEmail(null);
    setVerificationCode(null);
    setCodeInput("");
    setErrorMessage(null);
    setIsVerifying(false);
  };

  const handleEmailSubmit = () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      setErrorMessage("Enter a valid email address to continue.");
      return;
    }

    setPendingEmail(normalizedEmail);
    setVerificationCode(generateVerificationCode());
    setCodeInput("");
    setErrorMessage(null);
    setIsVerifying(false);
  };

  const handleCodeSubmit = () => {
    if (!verificationCode || !pendingEmail) {
      resetFlow();
      return;
    }

    if (codeInput.trim() !== verificationCode) {
      setErrorMessage("That code does not match. Try again or request a new one.");
      return;
    }

    setIsVerifying(true);
    auth.signIn({
      email: pendingEmail,
      signedInAt: new Date().toISOString(),
    });
  };

  return (
    <AuthShell
      eyebrow="Welcome"
      title="Welcome to T3CODER(DEV)."
      description="Enter your email in the chat-style auth flow and use a one-time code to unlock the desktop workspace."
    >
      <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,#0b0b0d_0%,#050505_100%)] p-3 shadow-[0_20px_80px_rgba(0,0,0,0.45)]">
        <div className="rounded-[24px] border border-white/10 bg-black/40 p-7 text-white">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.22em] text-zinc-500 uppercase">
                Authentication
              </p>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight">Let&apos;s sign you in.</h2>
            </div>
            {stage === "code" ? (
              <button
                type="button"
                onClick={resetFlow}
                className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-white/20 hover:text-white"
              >
                Back
              </button>
            ) : null}
          </div>

          <div className="mt-8 flex flex-col gap-3">
            <ChatBubble role="assistant">
              Welcome to T3CODER(DEV). Start with your email and I&apos;ll issue a one-time sign-in code.
            </ChatBubble>
            {pendingEmail ? <ChatBubble role="user">{pendingEmail}</ChatBubble> : null}
            {stage === "code" ? (
              <>
                <ChatBubble role="assistant">
                  I generated a {CODE_LENGTH}-digit code for this desktop session. Enter it below to
                  continue.
                </ChatBubble>
                <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm text-blue-100">
                  Dev code: <span className="font-semibold tracking-[0.28em]">{verificationCode}</span>
                </div>
              </>
            ) : null}
          </div>

          <div className="mt-8 flex flex-col gap-3">
            {stage === "email" ? (
              <>
                <label className="text-xs font-semibold tracking-[0.18em] text-zinc-500 uppercase">
                  Email
                </label>
                <input
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setErrorMessage(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleEmailSubmit();
                    }
                  }}
                  placeholder="you@t3coder.dev"
                  className="h-12 rounded-2xl border border-white/10 bg-[#0d0d11] px-4 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-blue-500/70"
                />
                <button
                  type="button"
                  onClick={handleEmailSubmit}
                  className="inline-flex h-12 w-full items-center justify-center rounded-2xl bg-white px-4 text-sm font-medium text-black transition hover:bg-zinc-200"
                >
                  Send code
                </button>
              </>
            ) : (
              <>
                <label className="text-xs font-semibold tracking-[0.18em] text-zinc-500 uppercase">
                  One-time code
                </label>
                <input
                  value={codeInput}
                  onChange={(event) => {
                    setCodeInput(event.target.value.replace(/\s+/g, ""));
                    setErrorMessage(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      handleCodeSubmit();
                    }
                  }}
                  placeholder="123456"
                  className="h-12 rounded-2xl border border-white/10 bg-[#0d0d11] px-4 text-sm tracking-[0.28em] text-white outline-none transition placeholder:tracking-normal placeholder:text-zinc-500 focus:border-blue-500/70"
                />
                <button
                  type="button"
                  onClick={handleCodeSubmit}
                  disabled={isVerifying}
                  className="inline-flex h-12 w-full items-center justify-center rounded-2xl bg-white px-4 text-sm font-medium text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-500/50"
                >
                  {isVerifying ? "Opening workspace..." : "Continue"}
                </button>
              </>
            )}
          </div>

          {errorMessage ? (
            <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {errorMessage}
            </div>
          ) : null}

          <div className="mt-8 rounded-2xl border border-white/10 bg-[#0c0c0f] px-4 py-3 text-xs leading-6 text-zinc-500">
            This is a first-party desktop auth flow. The one-time code stays local in dev mode for
            now, and the shell opens only after verification.
          </div>
        </div>
      </div>
    </AuthShell>
  );
}

export function AuthSetupScreen() {
  return (
    <AuthShell
      eyebrow="Authentication"
      title="Welcome to T3CODER(DEV)."
      description="The desktop app now uses a first-party passwordless entry flow instead of a hosted auth provider."
    >
      <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,#0b0b0d_0%,#050505_100%)] p-3 shadow-[0_20px_80px_rgba(0,0,0,0.45)]">
        <div className="rounded-[24px] border border-white/10 bg-black/40 p-7 text-white">
          <p className="text-[11px] font-semibold tracking-[0.22em] text-zinc-500 uppercase">
            Passwordless
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight">Chat-first desktop sign-in.</h2>
          <p className="mt-3 text-sm leading-7 text-zinc-400">
            Email-based local verification is built into the shell, so there is no external auth
            gate to configure before loading the workspace.
          </p>
        </div>
      </div>
    </AuthShell>
  );
}

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
    }),
    [session],
  );

  return (
    <DesktopAuthContext.Provider value={value}>
      {!isHydrated ? <AuthLoadingScreen /> : null}
      {isHydrated && session ? (
        <>
          {children}
        </>
      ) : null}
      {isHydrated && !session ? <AuthSignInScreen /> : null}
    </DesktopAuthContext.Provider>
  );
}

export function useDesktopAuth(): DesktopAuthContextValue {
  const context = useContext(DesktopAuthContext);
  if (!context) {
    throw new Error("useDesktopAuth must be used inside AppAuthGate.");
  }
  return context;
}
