import { Option, Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const CanvasFramework = Schema.Literal("react");
export type CanvasFramework = typeof CanvasFramework.Type;

export const CanvasFileLanguage = Schema.Literals(["jsx", "css", "md"]);
export type CanvasFileLanguage = typeof CanvasFileLanguage.Type;

export const CanvasFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  language: CanvasFileLanguage,
  contents: Schema.String,
});
export type CanvasFile = typeof CanvasFile.Type;

export const ThreadCanvasState = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some("Canvas App"))),
  framework: CanvasFramework.pipe(Schema.withConstructorDefault(() => Option.some("react"))),
  prompt: Schema.String.pipe(Schema.withConstructorDefault(() => Option.some(""))),
  files: Schema.Array(CanvasFile).pipe(Schema.withConstructorDefault(() => Option.some([]))),
  lastUpdatedAt: TrimmedNonEmptyString,
});
export type ThreadCanvasState = typeof ThreadCanvasState.Type;

export const CanvasGetStateInput = Schema.Struct({
  threadId: ThreadId,
});
export type CanvasGetStateInput = typeof CanvasGetStateInput.Type;

export const CanvasUpsertStateInput = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Array(CanvasFile)),
});
export type CanvasUpsertStateInput = typeof CanvasUpsertStateInput.Type;

