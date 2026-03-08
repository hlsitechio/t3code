/**
 * First-run dependency bootstrapper for T3 Code desktop app.
 *
 * On first launch (or when deps are missing), this module detects and
 * installs the required CLI tools so all providers work out of the box.
 *
 * Dependencies:
 * | Tool          | Required By                     | Install Method        |
 * |---------------|--------------------------------|----------------------|
 * | Node.js 22+   | Gemini CLI, Codex CLI (npm)    | winget / msi         |
 * | Git           | Claude Code, git operations     | winget               |
 * | GitHub CLI    | GitHub auth & repo ops          | winget               |
 * | Codex CLI     | OpenAI provider                 | npm -g               |
 * | Claude Code   | Anthropic provider              | npm -g               |
 * | Gemini CLI    | Google provider                 | npm -g               |
 */

import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import { app, dialog, BrowserWindow } from "electron";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export interface DepStatus {
  name: string;
  found: boolean;
  version: string | undefined;
  required: boolean;
}

interface BootstrapProgress {
  step: string;
  current: number;
  total: number;
}

type ProgressCallback = (progress: BootstrapProgress) => void;

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

async function which(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      process.platform === "win32" ? "where" : "which",
      [command],
      { timeout: 5000 },
    );
    const firstLine = stdout.trim().split(/\r?\n/)[0];
    return firstLine || null;
  } catch {
    return null;
  }
}

async function getVersion(command: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 10000 });
    const match = stdout.match(/(\d+\.\d+[\.\d]*)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dependency checks
// ---------------------------------------------------------------------------

async function checkNode(): Promise<DepStatus> {
  const path = await which("node");
  const version = path ? await getVersion("node") : null;
  return { name: "Node.js", found: !!path, version: version ?? undefined, required: true };
}

async function checkGit(): Promise<DepStatus> {
  const path = await which("git");
  const version = path ? await getVersion("git") : null;
  return { name: "Git", found: !!path, version: version ?? undefined, required: true };
}

async function checkGhCli(): Promise<DepStatus> {
  const path = await which("gh");
  const version = path ? await getVersion("gh") : null;
  return { name: "GitHub CLI", found: !!path, version: version ?? undefined, required: false };
}

async function checkCodex(): Promise<DepStatus> {
  const path = await which("codex");
  const version = path ? await getVersion("codex") : null;
  return { name: "Codex CLI", found: !!path, version: version ?? undefined, required: false };
}

async function checkClaude(): Promise<DepStatus> {
  const path = await which("claude");
  const version = path ? await getVersion("claude") : null;
  return { name: "Claude Code", found: !!path, version: version ?? undefined, required: false };
}

async function checkGemini(): Promise<DepStatus> {
  const path = await which("gemini");
  const version = path ? await getVersion("gemini") : null;
  return { name: "Gemini CLI", found: !!path, version: version ?? undefined, required: false };
}

// ---------------------------------------------------------------------------
// Check all deps
// ---------------------------------------------------------------------------

export async function checkAllDeps(): Promise<DepStatus[]> {
  return Promise.all([
    checkNode(),
    checkGit(),
    checkGhCli(),
    checkCodex(),
    checkClaude(),
    checkGemini(),
  ]);
}

// ---------------------------------------------------------------------------
// Install helpers (Windows-only for now — winget based)
// ---------------------------------------------------------------------------

async function hasWinget(): Promise<boolean> {
  return (await which("winget")) !== null;
}

async function wingetInstall(packageId: string, name: string): Promise<boolean> {
  try {
    await execAsync(
      `winget install --id ${packageId} --accept-package-agreements --accept-source-agreements --disable-interactivity --silent`,
      { timeout: 300000 },
    );
    return true;
  } catch (err) {
    console.error(`[bootstrap] Failed to install ${name} via winget:`, err);
    return false;
  }
}

async function npmInstallGlobal(packageName: string, name: string): Promise<boolean> {
  try {
    await execAsync(`npm install -g ${packageName}`, { timeout: 120000 });
    return true;
  } catch (err) {
    console.error(`[bootstrap] Failed to install ${name} via npm:`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap orchestrator
// ---------------------------------------------------------------------------

export async function bootstrapMissingDeps(
  deps: DepStatus[],
  onProgress?: ProgressCallback,
): Promise<{ installed: string[]; failed: string[] }> {
  const missing = deps.filter((d) => !d.found);
  if (missing.length === 0) return { installed: [], failed: [] };

  const installed: string[] = [];
  const failed: string[] = [];
  const total = missing.length;
  let current = 0;

  const useWinget = process.platform === "win32" && (await hasWinget());

  for (const dep of missing) {
    current++;
    onProgress?.({ step: `Installing ${dep.name}...`, current, total });

    let success = false;

    switch (dep.name) {
      case "Node.js":
        if (useWinget) {
          success = await wingetInstall("OpenJS.NodeJS.LTS", "Node.js");
        }
        break;

      case "Git":
        if (useWinget) {
          success = await wingetInstall("Git.Git", "Git");
        }
        break;

      case "GitHub CLI":
        if (useWinget) {
          success = await wingetInstall("GitHub.cli", "GitHub CLI");
        }
        break;

      case "Codex CLI":
        // Codex needs Node.js — check if we just installed it
        if (await which("node")) {
          success = await npmInstallGlobal("@openai/codex", "Codex CLI");
        }
        break;

      case "Claude Code":
        if (await which("node")) {
          success = await npmInstallGlobal("@anthropic-ai/claude-code", "Claude Code");
        }
        break;

      case "Gemini CLI":
        if (await which("node")) {
          success = await npmInstallGlobal("@google/gemini-cli", "Gemini CLI");
        }
        break;
    }

    if (success) {
      installed.push(dep.name);
    } else {
      failed.push(dep.name);
    }
  }

  return { installed, failed };
}

// ---------------------------------------------------------------------------
// First-run UI flow
// ---------------------------------------------------------------------------

export async function runFirstRunBootstrap(parentWindow?: BrowserWindow): Promise<void> {
  const deps = await checkAllDeps();
  const missing = deps.filter((d) => !d.found);

  if (missing.length === 0) {
    console.log("[bootstrap] All dependencies found.");
    return;
  }

  const missingNames = missing.map((d) => `  - ${d.name}${d.required ? " (required)" : ""}`);

  const result = await dialog.showMessageBox(parentWindow ?? BrowserWindow.getFocusedWindow()!, {
    type: "info",
    title: "T3 Code — First Run Setup",
    message: "Some tools need to be installed for full functionality:",
    detail: missingNames.join("\n") + "\n\nWould you like to install them now?",
    buttons: ["Install Now", "Skip for Now"],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response === 1) {
    console.log("[bootstrap] User skipped dependency installation.");
    return;
  }

  const { installed, failed } = await bootstrapMissingDeps(deps);

  if (installed.length > 0) {
    console.log("[bootstrap] Installed:", installed.join(", "));
  }

  if (failed.length > 0) {
    await dialog.showMessageBox(parentWindow ?? BrowserWindow.getFocusedWindow()!, {
      type: "warning",
      title: "T3 Code — Setup Incomplete",
      message: "Some tools could not be installed automatically:",
      detail:
        failed.join(", ") +
        "\n\nYou can install them manually:\n" +
        "  Node.js: https://nodejs.org\n" +
        "  Git: https://git-scm.com\n" +
        "  GitHub CLI: https://cli.github.com\n" +
        "  Codex: npm install -g @openai/codex\n" +
        "  Claude: npm install -g @anthropic-ai/claude-code\n" +
        "  Gemini: npm install -g @google/gemini-cli",
      buttons: ["OK"],
    });
  } else if (installed.length > 0) {
    await dialog.showMessageBox(parentWindow ?? BrowserWindow.getFocusedWindow()!, {
      type: "info",
      title: "T3 Code — Setup Complete",
      message: `Successfully installed: ${installed.join(", ")}`,
      detail: "You may need to restart T3 Code for PATH changes to take effect.",
      buttons: ["OK"],
    });
  }
}
