import { z } from "zod";

export const appSettingsSchema = z.object({
  codexBinaryPath: z.string().trim().max(4096).default(""),
  codexHomePath: z.string().trim().max(4096).default(""),
});

export const appSettingsUpdateInputSchema = z.object({
  codexBinaryPath: z.string().trim().max(4096).optional(),
  codexHomePath: z.string().trim().max(4096).optional(),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AppSettingsUpdateInput = z.input<typeof appSettingsUpdateInputSchema>;
