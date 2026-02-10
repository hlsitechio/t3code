import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatStartupError,
  ifMatchSatisfied,
  ifModifiedSinceSatisfied,
  ifNoneMatchSatisfied,
  ifRangeSatisfied,
  ifUnmodifiedSinceSatisfied,
  parseByteRangeHeader,
  parseCliOptions,
  readCliVersion,
  resolveStaticAssetReadTarget,
  resolveStaticAssetPath,
  validateLaunchDirectory,
} from "./cli";

describe("parseCliOptions", () => {
  it("reads defaults from environment variables", () => {
    const options = parseCliOptions(
      [],
      {
        T3_BACKEND_PORT: "5001",
        T3_WEB_PORT: "5002",
        T3_NO_OPEN: "1",
      },
      "/workspace",
    );

    expect(options.backendPort).toBe(5001);
    expect(options.webPort).toBe(5002);
    expect(options.noOpen).toBe(true);
    expect(options.launchCwd).toBe("/workspace");
    expect(options.backendPortLocked).toBe(true);
    expect(options.webPortLocked).toBe(true);
  });

  it("trims environment variable port values before parsing", () => {
    const options = parseCliOptions(
      [],
      {
        T3_BACKEND_PORT: " 5001 ",
        T3_WEB_PORT: " 5002 ",
      },
      "/workspace",
    );

    expect(options.backendPort).toBe(5001);
    expect(options.webPort).toBe(5002);
    expect(options.backendPortLocked).toBe(true);
    expect(options.webPortLocked).toBe(true);
  });

  it("accepts flexible truthy values for T3_NO_OPEN", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "true",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(true);
  });

  it("supports explicit equals-style --no-open boolean overrides", () => {
    const options = parseCliOptions(
      ["--no-open=false"],
      {
        T3_NO_OPEN: "true",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(false);
  });

  it("supports --open to override truthy no-open environment defaults", () => {
    const options = parseCliOptions(
      ["--open"],
      {
        T3_NO_OPEN: "true",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(false);
  });

  it("supports -o as a short alias for --open", () => {
    const options = parseCliOptions(
      ["-o"],
      {
        T3_NO_OPEN: "true",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(false);
  });

  it("supports equals-style -o boolean values", () => {
    const enabled = parseCliOptions(["-o=true"], { T3_NO_OPEN: "true" }, "/workspace");
    expect(enabled.noOpen).toBe(false);

    const disabled = parseCliOptions(["-o=0"], { T3_NO_OPEN: "false" }, "/workspace");
    expect(disabled.noOpen).toBe(true);
  });

  it("supports equals-style -o off values", () => {
    const options = parseCliOptions(["-o=off"], { T3_NO_OPEN: "true" }, "/workspace");
    expect(options.noOpen).toBe(true);
  });

  it("lets -o=true override truthy no-open environment defaults", () => {
    const options = parseCliOptions(["-o=true"], { T3_NO_OPEN: "yes" }, "/workspace");
    expect(options.noOpen).toBe(false);
  });

  it("supports explicit equals-style --open boolean overrides", () => {
    const options = parseCliOptions(
      ["--open=false"],
      {
        T3_NO_OPEN: "false",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(true);
  });

  it("supports equals-style --open true values", () => {
    const options = parseCliOptions(
      ["--open=true"],
      {
        T3_NO_OPEN: "true",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(false);
  });

  it("supports numeric equals-style --open values", () => {
    const enabled = parseCliOptions(["--open=1"], { T3_NO_OPEN: "true" }, "/workspace");
    expect(enabled.noOpen).toBe(false);

    const disabled = parseCliOptions(["--open=0"], { T3_NO_OPEN: "false" }, "/workspace");
    expect(disabled.noOpen).toBe(true);
  });

  it("supports equals-style --open off values", () => {
    const options = parseCliOptions(["--open=off"], {}, "/workspace");
    expect(options.noOpen).toBe(true);
  });

  it("trims equals-style --open values before parsing", () => {
    const options = parseCliOptions(["--open=  true  "], { T3_NO_OPEN: "true" }, "/workspace");
    expect(options.noOpen).toBe(false);
  });

  it("respects last flag when combining --open and --no-open", () => {
    const openThenNoOpen = parseCliOptions(["--open", "--no-open"], {}, "/workspace");
    expect(openThenNoOpen.noOpen).toBe(true);

    const noOpenThenOpen = parseCliOptions(["--no-open", "--open"], {}, "/workspace");
    expect(noOpenThenOpen.noOpen).toBe(false);
  });

  it("respects last equals-style open/no-open override", () => {
    const noOpenThenOpenFalse = parseCliOptions(
      ["--no-open=1", "--open=0"],
      {},
      "/workspace",
    );
    expect(noOpenThenOpenFalse.noOpen).toBe(true);

    const openFalseThenNoOpenFalse = parseCliOptions(
      ["--open=0", "--no-open=0"],
      {},
      "/workspace",
    );
    expect(openFalseThenNoOpenFalse.noOpen).toBe(false);
  });

  it("throws for invalid equals-style --open values", () => {
    expect(() => parseCliOptions(["--open=maybe"], {}, "/workspace")).toThrow(
      "Invalid value for --open",
    );
  });

  it("throws for invalid equals-style -o values", () => {
    expect(() => parseCliOptions(["-o=maybe"], {}, "/workspace")).toThrow(
      "Invalid value for -o",
    );
  });

  it("throws for empty equals-style -o values", () => {
    expect(() => parseCliOptions(["-o="], {}, "/workspace")).toThrow("Invalid value for -o");
  });

  it("throws for empty equals-style --open values", () => {
    expect(() => parseCliOptions(["--open="], {}, "/workspace")).toThrow(
      "Invalid value for --open",
    );
  });

  it("supports falsey equals-style --no-open values", () => {
    const options = parseCliOptions(["--no-open=0"], {}, "/workspace");
    expect(options.noOpen).toBe(false);
  });

  it("throws for invalid equals-style --no-open values", () => {
    expect(() => parseCliOptions(["--no-open=maybe"], {}, "/workspace")).toThrow(
      "Invalid value for --no-open",
    );
  });

  it("throws for empty equals-style --no-open values", () => {
    expect(() => parseCliOptions(["--no-open="], {}, "/workspace")).toThrow(
      "Invalid value for --no-open",
    );
  });

  it("parses case-insensitive equals-style --no-open values", () => {
    const options = parseCliOptions(["--no-open=ON"], {}, "/workspace");
    expect(options.noOpen).toBe(true);
  });

  it("trims equals-style --no-open values before parsing", () => {
    const options = parseCliOptions(["--no-open=  no  "], { T3_NO_OPEN: "true" }, "/workspace");
    expect(options.noOpen).toBe(false);
  });

  it("supports off as equals-style --no-open false value", () => {
    const options = parseCliOptions(["--no-open=off"], { T3_NO_OPEN: "true" }, "/workspace");
    expect(options.noOpen).toBe(false);
  });

  it("supports yes as equals-style --no-open true value", () => {
    const options = parseCliOptions(["--no-open=yes"], {}, "/workspace");
    expect(options.noOpen).toBe(true);
  });

  it("parses case-insensitive and trimmed T3_NO_OPEN truthy values", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "  YeS ",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(true);
  });

  it("accepts 'on' as T3_NO_OPEN truthy value", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "on",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(true);
  });

  it("accepts 'yes' as T3_NO_OPEN truthy value", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "yes",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(true);
  });

  it("treats non-truthy T3_NO_OPEN values as disabled", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "0",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(false);
  });

  it("treats false as disabled T3_NO_OPEN value", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "false",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(false);
  });

  it("treats unknown T3_NO_OPEN values as disabled", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "definitely-not-boolean",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(false);
  });

  it("treats off as disabled T3_NO_OPEN value", () => {
    const options = parseCliOptions(
      [],
      {
        T3_NO_OPEN: "off",
      },
      "/workspace",
    );
    expect(options.noOpen).toBe(false);
  });

  it("allows command line arguments to override defaults", () => {
    const options = parseCliOptions(
      [
        "--backend-port",
        "7001",
        "--web-port=7002",
        "--cwd",
        "apps/t3",
        "--no-open",
      ],
      {},
      "/workspace",
    );

    expect(options.backendPort).toBe(7001);
    expect(options.webPort).toBe(7002);
    expect(options.noOpen).toBe(true);
    expect(options.launchCwd).toBe(path.resolve("/workspace", "apps/t3"));
    expect(options.backendPortLocked).toBe(true);
    expect(options.webPortLocked).toBe(true);
  });

  it("accepts a positional cwd argument", () => {
    const options = parseCliOptions(["apps/renderer"], {}, "/workspace");
    expect(options.launchCwd).toBe(path.resolve("/workspace", "apps/renderer"));
  });

  it("trims positional cwd arguments before resolving path", () => {
    const options = parseCliOptions(["  apps/renderer  "], {}, "/workspace");
    expect(options.launchCwd).toBe(path.resolve("/workspace", "apps/renderer"));
  });

  it("resolves relative cwd arguments against provided parser cwd", () => {
    const options = parseCliOptions(["--cwd", "project"], {}, "/tmp/t3-root");
    expect(options.launchCwd).toBe(path.resolve("/tmp/t3-root", "project"));
  });

  it("rejects whitespace-only positional cwd arguments", () => {
    expect(() => parseCliOptions(["   "], {}, "/workspace")).toThrow("Invalid value for [path]");
  });

  it("rejects multiple positional cwd arguments", () => {
    expect(() => parseCliOptions(["apps/renderer", "apps/t3"], {}, "/workspace")).toThrow(
      "Unexpected positional argument: apps/t3",
    );
  });

  it("supports end-of-options marker for positional cwd values", () => {
    const options = parseCliOptions(["--", "-project"], {}, "/workspace");
    expect(options.launchCwd).toBe(path.resolve("/workspace", "-project"));
  });

  it("treats known flag tokens as positional values after end-of-options marker", () => {
    const options = parseCliOptions(["--", "--help"], {}, "/workspace");
    expect(options.launchCwd).toBe(path.resolve("/workspace", "--help"));
  });

  it("throws when end-of-options marker has no positional value", () => {
    expect(() => parseCliOptions(["--"], {}, "/workspace")).toThrow("Missing value for [path]");
  });

  it("throws when end-of-options marker has multiple positional values", () => {
    expect(() => parseCliOptions(["--", "apps/renderer", "apps/t3"], {}, "/workspace")).toThrow(
      "Unexpected positional argument: apps/t3",
    );
  });

  it("throws when end-of-options marker has extra values after flag-like path", () => {
    expect(() => parseCliOptions(["--", "--help", "apps/t3"], {}, "/workspace")).toThrow(
      "Unexpected positional argument: apps/t3",
    );
  });

  it("throws when end-of-options marker appears after positional cwd is already set", () => {
    expect(() => parseCliOptions(["apps/renderer", "--", "apps/t3"], {}, "/workspace")).toThrow(
      "Unexpected positional argument: apps/t3",
    );
  });

  it("keeps ports unlocked when using defaults", () => {
    const options = parseCliOptions([], {}, "/workspace");
    expect(options.backendPortLocked).toBe(false);
    expect(options.webPortLocked).toBe(false);
  });

  it("normalizes the parser cwd for default launch path", () => {
    const options = parseCliOptions([], {}, "apps/t3");
    expect(options.launchCwd).toBe(path.resolve("apps/t3"));
  });

  it("supports help flag", () => {
    const options = parseCliOptions(["--help"], {}, "/workspace");
    expect(options.showHelp).toBe(true);
  });

  it("supports short help flag alias", () => {
    const options = parseCliOptions(["-h"], {}, "/workspace");
    expect(options.showHelp).toBe(true);
  });

  it("supports version flag", () => {
    const options = parseCliOptions(["--version"], {}, "/workspace");
    expect(options.showVersion).toBe(true);
  });

  it("supports short version flag alias", () => {
    const options = parseCliOptions(["-v"], {}, "/workspace");
    expect(options.showVersion).toBe(true);
  });

  it("throws for invalid explicit port values", () => {
    expect(() => parseCliOptions(["--web-port", "nope"], {}, "/workspace")).toThrow(
      "Invalid value for --web-port",
    );
  });

  it("rejects non-decimal explicit port values", () => {
    expect(() => parseCliOptions(["--backend-port", "0x10"], {}, "/workspace")).toThrow(
      "Invalid value for --backend-port",
    );
  });

  it("rejects plus-prefixed explicit port values", () => {
    expect(() => parseCliOptions(["--web-port", "+4318"], {}, "/workspace")).toThrow(
      "Invalid value for --web-port",
    );
  });

  it("trims whitespace in explicit port values", () => {
    const options = parseCliOptions(
      ["--backend-port", " 7001 ", "--web-port= 7002 "],
      {},
      "/workspace",
    );
    expect(options.backendPort).toBe(7001);
    expect(options.webPort).toBe(7002);
  });

  it("throws for out-of-range explicit port values", () => {
    expect(() => parseCliOptions(["--backend-port", "65536"], {}, "/workspace")).toThrow(
      "Invalid value for --backend-port",
    );
  });

  it("throws for empty equals-style backend port values", () => {
    expect(() => parseCliOptions(["--backend-port="], {}, "/workspace")).toThrow(
      "Invalid value for --backend-port",
    );
  });

  it("throws for empty equals-style web port values", () => {
    expect(() => parseCliOptions(["--web-port="], {}, "/workspace")).toThrow(
      "Invalid value for --web-port",
    );
  });

  it("throws when backend port value is missing", () => {
    expect(() => parseCliOptions(["--backend-port"], {}, "/workspace")).toThrow(
      "Missing value for --backend-port",
    );
  });

  it("rejects negative backend port values provided as separate args", () => {
    expect(() => parseCliOptions(["--backend-port", "-1"], {}, "/workspace")).toThrow(
      "Invalid value for --backend-port",
    );
  });

  it("treats known flags after --backend-port as missing values", () => {
    expect(() => parseCliOptions(["--backend-port", "--web-port"], {}, "/workspace")).toThrow(
      "Missing value for --backend-port",
    );
  });

  it("treats --open after --backend-port as missing value", () => {
    expect(() => parseCliOptions(["--backend-port", "--open"], {}, "/workspace")).toThrow(
      "Missing value for --backend-port",
    );
  });

  it("treats -o after --backend-port as missing value", () => {
    expect(() => parseCliOptions(["--backend-port", "-o"], {}, "/workspace")).toThrow(
      "Missing value for --backend-port",
    );
  });

  it("treats -o=bool after --backend-port as missing value", () => {
    expect(() => parseCliOptions(["--backend-port", "-o=true"], {}, "/workspace")).toThrow(
      "Missing value for --backend-port",
    );
  });

  it("treats equals-style flag tokens after --backend-port as missing values", () => {
    expect(() =>
      parseCliOptions(["--backend-port", "--web-port=7000"], {}, "/workspace"),
    ).toThrow("Missing value for --backend-port");
  });

  it("treats --open equals-style tokens after --backend-port as missing values", () => {
    expect(() =>
      parseCliOptions(["--backend-port", "--open=false"], {}, "/workspace"),
    ).toThrow("Missing value for --backend-port");
  });

  it("treats end-of-options marker after --backend-port as missing value", () => {
    expect(() => parseCliOptions(["--backend-port", "--"], {}, "/workspace")).toThrow(
      "Missing value for --backend-port",
    );
  });

  it("throws when web port value is missing", () => {
    expect(() => parseCliOptions(["--web-port"], {}, "/workspace")).toThrow(
      "Missing value for --web-port",
    );
  });

  it("rejects negative web port values provided as separate args", () => {
    expect(() => parseCliOptions(["--web-port", "-1"], {}, "/workspace")).toThrow(
      "Invalid value for --web-port",
    );
  });

  it("treats known flags after --web-port as missing values", () => {
    expect(() => parseCliOptions(["--web-port", "--cwd"], {}, "/workspace")).toThrow(
      "Missing value for --web-port",
    );
  });

  it("treats --open after --web-port as missing value", () => {
    expect(() => parseCliOptions(["--web-port", "--open"], {}, "/workspace")).toThrow(
      "Missing value for --web-port",
    );
  });

  it("treats -o after --web-port as missing value", () => {
    expect(() => parseCliOptions(["--web-port", "-o"], {}, "/workspace")).toThrow(
      "Missing value for --web-port",
    );
  });

  it("treats -o=bool after --web-port as missing value", () => {
    expect(() => parseCliOptions(["--web-port", "-o=0"], {}, "/workspace")).toThrow(
      "Missing value for --web-port",
    );
  });

  it("treats equals-style flag tokens after --web-port as missing values", () => {
    expect(() =>
      parseCliOptions(["--web-port", "--backend-port=7000"], {}, "/workspace"),
    ).toThrow("Missing value for --web-port");
  });

  it("treats --open equals-style tokens after --web-port as missing values", () => {
    expect(() => parseCliOptions(["--web-port", "--open=true"], {}, "/workspace")).toThrow(
      "Missing value for --web-port",
    );
  });

  it("treats end-of-options marker after --web-port as missing value", () => {
    expect(() => parseCliOptions(["--web-port", "--"], {}, "/workspace")).toThrow(
      "Missing value for --web-port",
    );
  });

  it("throws for invalid environment port values", () => {
    expect(() => parseCliOptions([], { T3_WEB_PORT: "nope" }, "/workspace")).toThrow(
      "Invalid value for T3_WEB_PORT",
    );
  });

  it("rejects non-decimal environment port values", () => {
    expect(() => parseCliOptions([], { T3_WEB_PORT: "1e3" }, "/workspace")).toThrow(
      "Invalid value for T3_WEB_PORT",
    );
  });

  it("rejects plus-prefixed environment port values", () => {
    expect(() => parseCliOptions([], { T3_BACKEND_PORT: "+4317" }, "/workspace")).toThrow(
      "Invalid value for T3_BACKEND_PORT",
    );
  });

  it("throws for empty environment port values", () => {
    expect(() => parseCliOptions([], { T3_WEB_PORT: "" }, "/workspace")).toThrow(
      "Invalid value for T3_WEB_PORT",
    );
  });

  it("throws for out-of-range environment port values", () => {
    expect(() => parseCliOptions([], { T3_WEB_PORT: "65536" }, "/workspace")).toThrow(
      "Invalid value for T3_WEB_PORT",
    );
  });

  it("throws for out-of-range backend environment port values", () => {
    expect(() => parseCliOptions([], { T3_BACKEND_PORT: "65536" }, "/workspace")).toThrow(
      "Invalid value for T3_BACKEND_PORT",
    );
  });

  it("throws for whitespace-only backend environment port values", () => {
    expect(() => parseCliOptions([], { T3_BACKEND_PORT: "   " }, "/workspace")).toThrow(
      "Invalid value for T3_BACKEND_PORT",
    );
  });

  it("throws for invalid backend environment port values", () => {
    expect(() => parseCliOptions([], { T3_BACKEND_PORT: "nope" }, "/workspace")).toThrow(
      "Invalid value for T3_BACKEND_PORT",
    );
  });

  it("throws for empty cwd flag values", () => {
    expect(() => parseCliOptions(["--cwd="], {}, "/workspace")).toThrow(
      "Invalid value for --cwd",
    );
  });

  it("throws for whitespace-only equals-style cwd values", () => {
    expect(() => parseCliOptions(["--cwd=   "], {}, "/workspace")).toThrow(
      "Invalid value for --cwd",
    );
  });

  it("throws when cwd flag value is missing", () => {
    expect(() => parseCliOptions(["--cwd"], {}, "/workspace")).toThrow(
      "Missing value for --cwd",
    );
  });

  it("throws for whitespace-only cwd flag values", () => {
    expect(() => parseCliOptions(["--cwd", "   "], {}, "/workspace")).toThrow(
      "Invalid value for --cwd",
    );
  });

  it("trims cwd flag values before resolving path", () => {
    const options = parseCliOptions(["--cwd", "  apps/renderer  "], {}, "/workspace");
    expect(options.launchCwd).toBe(path.resolve("/workspace", "apps/renderer"));
  });

  it("accepts dash-prefixed cwd values with separate --cwd argument", () => {
    const options = parseCliOptions(["--cwd", "-project"], {}, "/workspace");
    expect(options.launchCwd).toBe(path.resolve("/workspace", "-project"));
  });

  it("accepts dash-prefixed cwd values with equals-style --cwd argument", () => {
    const options = parseCliOptions(["--cwd=-project"], {}, "/workspace");
    expect(options.launchCwd).toBe(path.resolve("/workspace", "-project"));
  });

  it("treats known flags after --cwd as missing values", () => {
    expect(() => parseCliOptions(["--cwd", "--help"], {}, "/workspace")).toThrow(
      "Missing value for --cwd",
    );
  });

  it("treats equals-style flag tokens after --cwd as missing values", () => {
    expect(() => parseCliOptions(["--cwd", "--open=false"], {}, "/workspace")).toThrow(
      "Missing value for --cwd",
    );
  });

  it("treats --open after --cwd as missing value", () => {
    expect(() => parseCliOptions(["--cwd", "--open"], {}, "/workspace")).toThrow(
      "Missing value for --cwd",
    );
  });

  it("treats -o after --cwd as missing value", () => {
    expect(() => parseCliOptions(["--cwd", "-o"], {}, "/workspace")).toThrow(
      "Missing value for --cwd",
    );
  });

  it("treats -o=bool after --cwd as missing value", () => {
    expect(() => parseCliOptions(["--cwd", "-o=false"], {}, "/workspace")).toThrow(
      "Missing value for --cwd",
    );
  });

  it("treats end-of-options marker after --cwd as missing value", () => {
    expect(() => parseCliOptions(["--cwd", "--"], {}, "/workspace")).toThrow(
      "Missing value for --cwd",
    );
  });

  it("throws for unknown arguments", () => {
    expect(() => parseCliOptions(["--wat"], {}, "/workspace")).toThrow(
      "Unknown argument: --wat",
    );
  });

  it("throws for unknown equals-style arguments", () => {
    expect(() => parseCliOptions(["--wat=value"], {}, "/workspace")).toThrow(
      "Unknown argument: --wat=value",
    );
  });

  it("throws for unknown short arguments", () => {
    expect(() => parseCliOptions(["-x"], {}, "/workspace")).toThrow(
      "Unknown argument: -x",
    );
  });
});

describe("readCliVersion", () => {
  it("prefers npm_package_version from environment", () => {
    const value = readCliVersion("/tmp/does-not-matter.json", {
      npm_package_version: "9.9.9",
    });
    expect(value).toBe("9.9.9");
  });

  it("trims npm_package_version from environment", () => {
    const value = readCliVersion("/tmp/does-not-matter.json", {
      npm_package_version: " 9.9.9 ",
    });
    expect(value).toBe("9.9.9");
  });

  it("falls back when npm_package_version is whitespace-only", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-version-env-fallback-"));
    const packageJsonPath = path.join(tempDir, "package.json");
    writeFileSync(packageJsonPath, JSON.stringify({ version: "1.2.3" }), "utf8");
    const value = readCliVersion(packageJsonPath, {
      npm_package_version: "   ",
    });
    expect(value).toBe("1.2.3");
  });

  it("falls back to package json version when env is missing", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-version-test-"));
    const packageJsonPath = path.join(tempDir, "package.json");
    writeFileSync(packageJsonPath, JSON.stringify({ version: "1.2.3" }), "utf8");
    const value = readCliVersion(packageJsonPath, {});
    expect(value).toBe("1.2.3");
  });

  it("returns default when env and package file are unavailable", () => {
    const value = readCliVersion("/tmp/no-such-package.json", {});
    expect(value).toBe("0.1.0");
  });

  it("trims package json version before returning", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-version-trim-test-"));
    const packageJsonPath = path.join(tempDir, "package.json");
    writeFileSync(packageJsonPath, JSON.stringify({ version: " 1.2.3 " }), "utf8");
    const value = readCliVersion(packageJsonPath, {});
    expect(value).toBe("1.2.3");
  });
});

describe("formatStartupError", () => {
  const options = parseCliOptions([], {}, "/workspace");

  it("returns helpful guidance for port conflicts", () => {
    const message = formatStartupError({ code: "EADDRINUSE" }, options);
    expect(message).toContain("Port already in use");
    expect(message).toContain("--backend-port");
  });

  it("returns error message when available", () => {
    const message = formatStartupError(new Error("boom"), options);
    expect(message).toBe("boom");
  });

  it("falls back to generic startup error text", () => {
    const message = formatStartupError({}, options);
    expect(message).toBe("Failed to start t3 runtime.");
  });
});

describe("validateLaunchDirectory", () => {
  it("returns resolved path for existing directories", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-launch-dir-"));
    expect(validateLaunchDirectory(tempDir)).toBe(path.resolve(tempDir));
  });

  it("resolves relative directory paths against process cwd", () => {
    expect(validateLaunchDirectory(".")).toBe(path.resolve("."));
  });

  it("throws for missing launch directories", () => {
    const missing = path.join(os.tmpdir(), `t3-missing-dir-${Date.now()}`);
    expect(() => validateLaunchDirectory(missing)).toThrow("Launch directory does not exist");
  });

  it("throws when launch path points to a file", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-launch-file-"));
    const filePath = path.join(tempDir, "not-a-dir.txt");
    writeFileSync(filePath, "content", "utf8");
    expect(() => validateLaunchDirectory(filePath)).toThrow("Launch path is not a directory");
  });
});

describe("resolveStaticAssetPath", () => {
  const distRoot = "/workspace/apps/renderer/dist";

  it("maps root path to index.html", () => {
    const result = resolveStaticAssetPath("/", distRoot);
    expect(result).toEqual({
      kind: "file",
      filePath: path.join(distRoot, "index.html"),
    });
  });

  it("maps request paths without query strings", () => {
    const result = resolveStaticAssetPath("/assets/main.js?v=123", distRoot);
    expect(result).toEqual({
      kind: "file",
      filePath: path.join(distRoot, "assets", "main.js"),
    });
  });

  it("strips hash fragments when resolving request paths", () => {
    const result = resolveStaticAssetPath("/assets/main.js#chunk", distRoot);
    expect(result).toEqual({
      kind: "file",
      filePath: path.join(distRoot, "assets", "main.js"),
    });
  });

  it("strips query strings before hash fragments when resolving paths", () => {
    const result = resolveStaticAssetPath("/assets/main.js?v=123#chunk", distRoot);
    expect(result).toEqual({
      kind: "file",
      filePath: path.join(distRoot, "assets", "main.js"),
    });
  });

  it("supports absolute-form request targets by using URL pathname", () => {
    const result = resolveStaticAssetPath("http://127.0.0.1/assets/main.js?x=1", distRoot);
    expect(result).toEqual({
      kind: "file",
      filePath: path.join(distRoot, "assets", "main.js"),
    });
  });

  it("supports uppercase absolute-form request target schemes", () => {
    const result = resolveStaticAssetPath("HTTP://127.0.0.1/assets/main.js?x=1", distRoot);
    expect(result).toEqual({
      kind: "file",
      filePath: path.join(distRoot, "assets", "main.js"),
    });
  });

  it("rejects malformed absolute-form request targets", () => {
    const result = resolveStaticAssetPath("http://%zz", distRoot);
    expect(result).toEqual({
      kind: "bad_request",
    });
  });

  it("rejects traversal attempts with decoded dot-dot segments", () => {
    const result = resolveStaticAssetPath("/../package.json", distRoot);
    expect(result).toEqual({
      kind: "forbidden",
    });
  });

  it("rejects traversal attempts with encoded dot-dot segments", () => {
    const result = resolveStaticAssetPath("/%2e%2e/%2e%2e/package.json", distRoot);
    expect(result).toEqual({
      kind: "forbidden",
    });
  });

  it("rejects malformed encoded paths", () => {
    const result = resolveStaticAssetPath("/%E0%A4%A", distRoot);
    expect(result).toEqual({
      kind: "bad_request",
    });
  });

  it("rejects null-byte encoded paths", () => {
    const result = resolveStaticAssetPath("/index.html%00", distRoot);
    expect(result).toEqual({
      kind: "bad_request",
    });
  });
});

describe("parseByteRangeHeader", () => {
  it("returns null when range header is missing", () => {
    expect(parseByteRangeHeader(undefined, 100)).toBeNull();
  });

  it("rejects non-integer and negative file sizes", () => {
    expect(parseByteRangeHeader("bytes=0-1", -1)).toBe("invalid");
    expect(parseByteRangeHeader("bytes=0-1", 1.5)).toBe("invalid");
  });

  it("parses explicit start/end ranges", () => {
    expect(parseByteRangeHeader("bytes=0-9", 100)).toEqual({
      start: 0,
      end: 9,
    });
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseByteRangeHeader("  bytes=0-9  ", 100)).toEqual({
      start: 0,
      end: 9,
    });
  });

  it("parses case-insensitive byte-unit prefixes", () => {
    expect(parseByteRangeHeader("ByTeS=0-9", 100)).toEqual({
      start: 0,
      end: 9,
    });
  });

  it("parses open-ended ranges", () => {
    expect(parseByteRangeHeader("bytes=10-", 100)).toEqual({
      start: 10,
      end: 99,
    });
  });

  it("parses suffix ranges", () => {
    expect(parseByteRangeHeader("bytes=-5", 100)).toEqual({
      start: 95,
      end: 99,
    });
  });

  it("clamps explicit range ends to file size", () => {
    expect(parseByteRangeHeader("bytes=90-1000", 100)).toEqual({
      start: 90,
      end: 99,
    });
  });

  it("rejects malformed and unsatisfiable ranges", () => {
    expect(parseByteRangeHeader("items=0-1", 100)).toBe("invalid");
    expect(parseByteRangeHeader("bytes=0-1,2-3", 100)).toBe("invalid");
    expect(parseByteRangeHeader("bytes=-", 100)).toBe("invalid");
    expect(parseByteRangeHeader("bytes=10-9", 100)).toBe("invalid");
    expect(parseByteRangeHeader("bytes=100-101", 100)).toBe("invalid");
    expect(parseByteRangeHeader("bytes=-0", 100)).toBe("invalid");
    expect(parseByteRangeHeader("bytes=0-0", 0)).toBe("invalid");
    expect(parseByteRangeHeader("bytes=-1", 0)).toBe("invalid");
  });
});

describe("ifNoneMatchSatisfied", () => {
  it("returns false when header is missing or empty", () => {
    expect(ifNoneMatchSatisfied(undefined, "\"abc\"")).toBe(false);
    expect(ifNoneMatchSatisfied("   ", "\"abc\"")).toBe(false);
  });

  it("supports wildcard in array-valued headers", () => {
    expect(ifNoneMatchSatisfied(["\"foo\"", "*"], "\"abc\"")).toBe(true);
  });

  it("matches wildcard headers", () => {
    expect(ifNoneMatchSatisfied("*", "\"abc\"")).toBe(true);
  });

  it("matches exact etags from comma-separated lists", () => {
    expect(ifNoneMatchSatisfied("\"foo\", \"bar\", \"abc\"", "\"abc\"")).toBe(true);
  });

  it("matches weak and strong forms using weak comparison semantics", () => {
    expect(ifNoneMatchSatisfied("W/\"abc\"", "\"abc\"")).toBe(true);
    expect(ifNoneMatchSatisfied("\"abc\"", "W/\"abc\"")).toBe(true);
    expect(ifNoneMatchSatisfied("w/\"abc\"", "\"abc\"")).toBe(true);
    expect(ifNoneMatchSatisfied("   W/\"abc\"   ", "\"abc\"")).toBe(true);
  });

  it("does not match non-identical etags", () => {
    expect(ifNoneMatchSatisfied("\"foo\", \"bar\"", "\"abc\"")).toBe(false);
  });

  it("supports array-valued header representations", () => {
    expect(ifNoneMatchSatisfied(["\"foo\"", "\"abc\""], "\"abc\"")).toBe(true);
  });
});

describe("ifMatchSatisfied", () => {
  it("defaults to true when header is missing", () => {
    expect(ifMatchSatisfied(undefined, "\"abc\"")).toBe(true);
  });

  it("treats empty header values as non-restrictive", () => {
    expect(ifMatchSatisfied("   ", "\"abc\"")).toBe(true);
  });

  it("supports wildcard and exact strong matches", () => {
    expect(ifMatchSatisfied("*", "\"abc\"")).toBe(true);
    expect(ifMatchSatisfied("\"abc\"", "\"abc\"")).toBe(true);
  });

  it("supports comma-separated header values", () => {
    expect(ifMatchSatisfied("\"foo\", \"abc\"", "\"abc\"")).toBe(true);
    expect(ifMatchSatisfied("\"foo\", *", "\"abc\"")).toBe(true);
  });

  it("rejects weak validators and mismatches", () => {
    expect(ifMatchSatisfied("W/\"abc\"", "\"abc\"")).toBe(false);
    expect(ifMatchSatisfied("w/\"abc\"", "\"abc\"")).toBe(false);
    expect(ifMatchSatisfied("\"xyz\"", "\"abc\"")).toBe(false);
  });

  it("rejects weak current etags for strong If-Match comparisons", () => {
    expect(ifMatchSatisfied("\"abc\"", "W/\"abc\"")).toBe(false);
  });

  it("supports array-valued headers", () => {
    expect(ifMatchSatisfied(["\"foo\"", "\"abc\""], "\"abc\"")).toBe(true);
  });
});

describe("ifModifiedSinceSatisfied", () => {
  it("returns false for missing or invalid dates", () => {
    expect(ifModifiedSinceSatisfied(undefined, Date.now())).toBe(false);
    expect(ifModifiedSinceSatisfied("not-a-date", Date.now())).toBe(false);
  });

  it("returns true when resource has not changed since provided timestamp", () => {
    const modifiedAt = Date.parse("2026-01-01T12:00:00.100Z");
    expect(ifModifiedSinceSatisfied("Thu, 01 Jan 2026 12:00:00 GMT", modifiedAt)).toBe(true);
  });

  it("returns false when resource changed after provided timestamp", () => {
    const modifiedAt = Date.parse("2026-01-01T12:00:01.000Z");
    expect(ifModifiedSinceSatisfied("Thu, 01 Jan 2026 12:00:00 GMT", modifiedAt)).toBe(false);
  });

  it("supports array-valued header representations", () => {
    const modifiedAt = Date.parse("2026-01-01T12:00:00.000Z");
    expect(ifModifiedSinceSatisfied(["Thu, 01 Jan 2026 12:00:00 GMT"], modifiedAt)).toBe(true);
  });
});

describe("ifUnmodifiedSinceSatisfied", () => {
  it("defaults to true for missing and invalid values", () => {
    expect(ifUnmodifiedSinceSatisfied(undefined, Date.now())).toBe(true);
    expect(ifUnmodifiedSinceSatisfied("not-a-date", Date.now())).toBe(true);
  });

  it("returns true when resource has not changed since timestamp", () => {
    const modifiedAt = Date.parse("2026-01-01T12:00:00.100Z");
    expect(ifUnmodifiedSinceSatisfied("Thu, 01 Jan 2026 12:00:00 GMT", modifiedAt)).toBe(true);
  });

  it("returns false when resource changed after timestamp", () => {
    const modifiedAt = Date.parse("2026-01-01T12:00:01.000Z");
    expect(ifUnmodifiedSinceSatisfied("Thu, 01 Jan 2026 12:00:00 GMT", modifiedAt)).toBe(false);
  });

  it("uses first value when header is provided as an array", () => {
    const modifiedAt = Date.parse("2026-01-01T12:00:00.000Z");
    expect(
      ifUnmodifiedSinceSatisfied(["Thu, 01 Jan 2026 12:00:00 GMT", "Wed, 31 Dec 2025 12:00:00 GMT"], modifiedAt),
    ).toBe(true);
  });
});

describe("ifRangeSatisfied", () => {
  it("returns true when header is missing", () => {
    expect(ifRangeSatisfied(undefined, "\"abc\"", Date.now())).toBe(true);
  });

  it("requires exact strong etag match", () => {
    expect(ifRangeSatisfied("\"abc\"", "\"abc\"", Date.now())).toBe(true);
    expect(ifRangeSatisfied("\"abc\"", "\"xyz\"", Date.now())).toBe(false);
    expect(ifRangeSatisfied("W/\"abc\"", "\"abc\"", Date.now())).toBe(false);
    expect(ifRangeSatisfied("w/\"abc\"", "\"abc\"", Date.now())).toBe(false);
  });

  it("rejects wildcard etag values", () => {
    expect(ifRangeSatisfied("*", "\"abc\"", Date.now())).toBe(false);
  });

  it("supports HTTP-date if-range values", () => {
    const modifiedAt = Date.parse("2026-01-01T12:00:00.100Z");
    expect(ifRangeSatisfied("Thu, 01 Jan 2026 12:00:00 GMT", "\"etag\"", modifiedAt)).toBe(true);
    expect(
      ifRangeSatisfied("Thu, 01 Jan 2026 11:59:59 GMT", "\"etag\"", Date.parse("2026-01-01T12:00:01.000Z")),
    ).toBe(false);
  });

  it("supports array-valued headers and rejects invalid date forms", () => {
    const modifiedAt = Date.parse("2026-01-01T12:00:00.000Z");
    expect(ifRangeSatisfied(["\"etag\""], "\"etag\"", modifiedAt)).toBe(true);
    expect(ifRangeSatisfied(["\"etag\"", "\"other\""], "\"etag\"", modifiedAt)).toBe(true);
    expect(ifRangeSatisfied("not-a-date", "\"etag\"", modifiedAt)).toBe(false);
  });
});

describe("resolveStaticAssetReadTarget", () => {
  it("falls back to index for unknown routes", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-static-route-"));
    writeFileSync(path.join(tempDir, "index.html"), "<html>ok</html>", "utf8");

    const result = resolveStaticAssetReadTarget("/unknown/route", tempDir);
    expect(result).toEqual({
      kind: "file",
      filePath: path.join(tempDir, "index.html"),
    });
  });

  it("returns concrete file paths for existing assets", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-static-asset-"));
    const assetsDir = path.join(tempDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(tempDir, "index.html"), "<html>ok</html>", "utf8");
    writeFileSync(path.join(assetsDir, "main.js"), "console.log('ok')", "utf8");

    const result = resolveStaticAssetReadTarget("/assets/main.js", tempDir);
    expect(result).toEqual({
      kind: "file",
      filePath: path.join(assetsDir, "main.js"),
    });
  });

  it("resolves absolute-form request targets to in-dist assets", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-static-absolute-target-"));
    const assetsDir = path.join(tempDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(tempDir, "index.html"), "<html>ok</html>", "utf8");
    writeFileSync(path.join(assetsDir, "main.js"), "console.log('ok')", "utf8");

    const result = resolveStaticAssetReadTarget(
      "http://127.0.0.1/assets/main.js?cache=1",
      tempDir,
    );
    expect(result).toEqual({
      kind: "file",
      filePath: path.join(assetsDir, "main.js"),
    });
  });

  it("returns not_found for missing asset files with extensions", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-static-missing-asset-"));
    writeFileSync(path.join(tempDir, "index.html"), "<html>ok</html>", "utf8");

    const result = resolveStaticAssetReadTarget("/assets/missing.js", tempDir);
    expect(result).toEqual({
      kind: "not_found",
    });
  });

  it("rejects symlinked files that escape the dist directory", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-static-symlink-"));
    writeFileSync(path.join(tempDir, "index.html"), "<html>ok</html>", "utf8");
    const outsideFile = path.join(os.tmpdir(), `t3-outside-${Date.now()}.txt`);
    writeFileSync(outsideFile, "outside", "utf8");
    symlinkSync(outsideFile, path.join(tempDir, "outside.txt"));

    const result = resolveStaticAssetReadTarget("/outside.txt", tempDir);
    expect(result).toEqual({
      kind: "forbidden",
    });
  });

  it("allows symlinked files that resolve inside dist directory", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-static-symlink-inside-"));
    const assetsDir = path.join(tempDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(tempDir, "index.html"), "<html>ok</html>", "utf8");
    writeFileSync(path.join(assetsDir, "main.js"), "console.log('ok')", "utf8");
    symlinkSync(path.join(assetsDir, "main.js"), path.join(tempDir, "linked-main.js"));

    const result = resolveStaticAssetReadTarget("/linked-main.js", tempDir);
    expect(result).toEqual({
      kind: "file",
      filePath: path.join(assetsDir, "main.js"),
    });
  });

  it("returns not_found when spa fallback file is missing", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-static-missing-index-"));
    const result = resolveStaticAssetReadTarget("/missing.js", tempDir);
    expect(result).toEqual({
      kind: "not_found",
    });
  });
});
