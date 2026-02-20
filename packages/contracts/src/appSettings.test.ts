import { describe, expect, it } from "vitest";

import { appSettingsSchema, appSettingsUpdateInputSchema } from "./appSettings";

describe("appSettings schemas", () => {
  it("applies defaults for codex paths", () => {
    expect(appSettingsSchema.parse({})).toEqual({
      codexBinaryPath: "",
      codexHomePath: "",
    });
  });

  it("trims codex path overrides in updates", () => {
    expect(
      appSettingsUpdateInputSchema.parse({
        codexBinaryPath: "  /opt/codex/bin/codex  ",
        codexHomePath: "  /Users/alice/.codex  ",
      }),
    ).toEqual({
      codexBinaryPath: "/opt/codex/bin/codex",
      codexHomePath: "/Users/alice/.codex",
    });
  });
});
