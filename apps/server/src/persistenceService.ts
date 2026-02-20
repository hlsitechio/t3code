import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { parsePatchFiles } from "@pierre/diffs";
import {
  DEFAULT_MODEL,
  type AppSettings,
  type AppSettingsUpdateInput,
  appSettingsSchema,
  appSettingsUpdateInputSchema,
  type ProjectAddInput,
  type ProjectAddResult,
  type ProjectListResult,
  type ProjectRemoveInput,
  type ProjectUpdateScriptsInput,
  type ProjectUpdateScriptsResult,
  type ProviderEvent,
  type ProviderSendTurnInput,
  type StateBootstrapResult,
  type StateBootstrapThread,
  type StateCatchUpInput,
  type StateCatchUpResult,
  type StateEvent,
  type StateImportLegacyRendererStateInput,
  type StateImportLegacyRendererStateResult,
  type StateListMessagesInput,
  type StateListMessagesResult,
  type StateMessage,
  type StateProject,
  type StateThread,
  type StateTurnDiffFileChange,
  type StateTurnSummary,
  type ThreadsCreateInput,
  type ThreadsDeleteInput,
  type ThreadsMarkVisitedInput,
  type ThreadsUpdateBranchInput,
  type ThreadsUpdateModelInput,
  type ThreadsUpdateResult,
  type ThreadsUpdateTerminalStateInput,
  type ThreadsUpdateTitleInput,
  normalizeProjectScripts,
  projectAddInputSchema,
  projectRecordSchema,
  projectRemoveInputSchema,
  projectScriptsSchema,
  projectUpdateScriptsInputSchema,
  stateBootstrapResultSchema,
  stateCatchUpInputSchema,
  stateCatchUpResultSchema,
  stateEventSchema,
  stateImportLegacyRendererStateInputSchema,
  stateListMessagesInputSchema,
  stateListMessagesResultSchema,
  stateMessageSchema,
  stateProjectSchema,
  stateThreadSchema,
  stateTurnSummarySchema,
  threadsCreateInputSchema,
  threadsDeleteInputSchema,
  threadsMarkVisitedInputSchema,
  threadsUpdateBranchInputSchema,
  threadsUpdateModelInputSchema,
  threadsUpdateTerminalStateInputSchema,
  threadsUpdateTitleInputSchema,
  threadsUpdateResultSchema,
} from "@t3tools/contracts";

import { StateDb } from "./stateDb";

const METADATA_KEY_PROJECTS_JSON_IMPORTED = "migration.projects_json_imported";
const METADATA_KEY_LEGACY_RENDERER_IMPORTED = "migration.legacy_renderer_imported";
const METADATA_KEY_APP_SETTINGS = "app.settings.v1";
const MAX_TERMINAL_COUNT = 4;
const DEFAULT_TERMINAL_ID = "default";
const DEFAULT_TERMINAL_HEIGHT = 280;

interface DocumentRow {
  id: string;
  kind: string;
  project_id: string | null;
  thread_id: string | null;
  sort_key: number | null;
  created_at: string;
  updated_at: string;
  data_json: string;
}

interface StateEventRow {
  seq: number;
  event_type: string;
  entity_id: string;
  payload_json: string;
  created_at: string;
}

interface ProviderEventInsertResult {
  inserted: boolean;
  runtimeThreadId: string | null;
}

export interface PersistenceServiceOptions {
  dbPath: string;
  legacyProjectsJsonPath?: string;
}

export interface PersistenceServiceEvents {
  stateEvent: [event: StateEvent];
}

interface UpsertDocumentInput {
  id: string;
  kind: "project" | "thread" | "message" | "turn_summary";
  projectId: string | null;
  threadId: string | null;
  sortKey: number | null;
  createdAt: string;
  updatedAt: string;
  data: unknown;
}

interface SafeParseSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

function nowIso(): string {
  return new Date().toISOString();
}

function toSafeInteger(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return fallback;
}

function normalizeCwd(rawCwd: string): string {
  const resolved = path.resolve(rawCwd.trim());
  const normalized = path.normalize(resolved);
  if (process.platform === "win32") {
    return normalized.toLowerCase();
  }
  return normalized;
}

function isDirectory(cwd: string): boolean {
  try {
    return fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

function inferProjectName(cwd: string): string {
  const name = path.basename(cwd);
  return name.length > 0 ? name : "project";
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseThreadIdFromEventPayload(payload: unknown): string | null {
  const record = asObject(payload);
  const threadId = asString(record?.threadId) ?? asString(record?.thread_id);
  if (threadId) return threadId;
  const thread = asObject(record?.thread);
  return asString(thread?.id) ?? null;
}

function parseTurnIdFromEvent(event: ProviderEvent): string | null {
  if (event.turnId) return event.turnId;
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  return asString(turn?.id) ?? null;
}

function parseAssistantItemId(event: ProviderEvent): string | null {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const itemType = asString(item?.type);
  if (itemType !== "agentMessage") return null;
  return asString(item?.id) ?? event.itemId ?? null;
}

function normalizeTerminalIds(ids: readonly string[]): string[] {
  const normalized = [
    ...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)),
  ].slice(0, MAX_TERMINAL_COUNT);
  if (normalized.length > 0) {
    return normalized;
  }
  return [DEFAULT_TERMINAL_ID];
}

function normalizeRunningTerminalIds(
  runningTerminalIds: readonly string[],
  terminalIds: readonly string[],
): string[] {
  if (runningTerminalIds.length === 0) {
    return [];
  }

  const validTerminalIds = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIds.has(id))
    .slice(0, MAX_TERMINAL_COUNT);
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(groupId: string, usedGroupIds: Set<string>): string {
  if (!usedGroupIds.has(groupId)) {
    usedGroupIds.add(groupId);
    return groupId;
  }

  let suffix = 2;
  while (usedGroupIds.has(`${groupId}-${suffix}`)) {
    suffix += 1;
  }
  const uniqueGroupId = `${groupId}-${suffix}`;
  usedGroupIds.add(uniqueGroupId);
  return uniqueGroupId;
}

function normalizeTerminalGroups(
  groups: StateThread["terminalGroups"],
  terminalIds: readonly string[],
): StateThread["terminalGroups"] {
  const validTerminalIds = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const usedGroupIds = new Set<string>();
  const normalizedGroups: StateThread["terminalGroups"] = [];

  for (const group of groups) {
    const groupTerminalIds = [
      ...new Set(group.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
    ].filter((terminalId) => {
      if (!validTerminalIds.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? DEFAULT_TERMINAL_ID);
    normalizedGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    normalizedGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (normalizedGroups.length > 0) {
    return normalizedGroups;
  }

  return [{ id: fallbackGroupId(DEFAULT_TERMINAL_ID), terminalIds: [DEFAULT_TERMINAL_ID] }];
}

function normalizeThread(thread: StateThread): StateThread {
  const terminalIds = normalizeTerminalIds(thread.terminalIds);
  const runningTerminalIds = normalizeRunningTerminalIds(thread.runningTerminalIds, terminalIds);
  const activeTerminalId = terminalIds.includes(thread.activeTerminalId)
    ? thread.activeTerminalId
    : (terminalIds[0] ?? DEFAULT_TERMINAL_ID);
  const terminalGroups = normalizeTerminalGroups(thread.terminalGroups, terminalIds);
  const activeGroupId =
    terminalGroups.find((group) => group.id === thread.activeTerminalGroupId)?.id ??
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(activeTerminalId);

  return {
    ...thread,
    terminalIds,
    runningTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId: activeGroupId,
  };
}

function projectDocId(projectId: string): string {
  return `project:${projectId}`;
}

function threadDocId(threadId: string): string {
  return `thread:${threadId}`;
}

function messageDocId(threadId: string, messageId: string): string {
  return `message:${threadId}:${messageId}`;
}

function turnSummaryDocId(threadId: string, turnId: string): string {
  return `turn_summary:${threadId}:${turnId}`;
}

function parsePathFromDiff(diff: string): string | null {
  const normalized = diff.replace(/\r\n/g, "\n");
  const bPath = normalized.match(/^\+\+\+ b\/(.+)$/m);
  if (bPath?.[1]) return bPath[1];
  const gitHeader = normalized.match(/^diff --git a\/(.+) b\/\1$/m);
  if (gitHeader?.[1]) return gitHeader[1];
  const direct = normalized.match(/^\+\+\+ (.+)$/m);
  if (!direct?.[1] || direct[1] === "/dev/null") {
    return null;
  }
  return direct[1];
}

function splitUnifiedDiffByFile(diff: string): Map<string, string> {
  const normalized = diff.replace(/\r\n/g, "\n");
  const byPath = new Map<string, string>();
  const headerMatches = [...normalized.matchAll(/^diff --git .+$/gm)];

  if (headerMatches.length === 0) {
    const pathFromDiff = parsePathFromDiff(normalized);
    if (pathFromDiff) {
      byPath.set(pathFromDiff, normalized.trim());
    }
    return byPath;
  }

  for (let index = 0; index < headerMatches.length; index += 1) {
    const match = headerMatches[index];
    if (!match) continue;
    const start = match.index ?? 0;
    const end = headerMatches[index + 1]?.index ?? normalized.length;
    const segment = normalized.slice(start, end).trim();
    const pathFromDiff = parsePathFromDiff(segment);
    if (!pathFromDiff || segment.length === 0) continue;
    byPath.set(pathFromDiff, segment);
  }

  return byPath;
}

function countDiffStat(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function summarizeUnifiedDiff(diff: string): StateTurnDiffFileChange[] {
  try {
    const parsedPatches = parsePatchFiles(diff, "state-turn-summary", false);
    const files: StateTurnDiffFileChange[] = [];
    for (const patch of parsedPatches) {
      for (const file of patch.files) {
        const additions = file.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0);
        const deletions = file.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0);
        files.push({
          path: file.name,
          kind: file.type,
          additions,
          deletions,
        });
      }
    }
    if (files.length > 0) {
      return files.toSorted((a, b) => a.path.localeCompare(b.path));
    }
  } catch {
    // Fallback below.
  }

  const fileDiffsByPath = splitUnifiedDiffByFile(diff);
  const fallback: StateTurnDiffFileChange[] = [];
  for (const [filePath, fileDiff] of fileDiffsByPath) {
    const stat = countDiffStat(fileDiff);
    fallback.push({
      path: filePath,
      additions: stat.additions,
      deletions: stat.deletions,
    });
  }
  return fallback.toSorted((a, b) => a.path.localeCompare(b.path));
}

function mergeTurnSummaryFiles(
  existing: StateTurnDiffFileChange[],
  incoming: StateTurnDiffFileChange[],
): StateTurnDiffFileChange[] {
  const byPath = new Map(existing.map((file) => [file.path, { ...file }] as const));
  for (const file of incoming) {
    const previous = byPath.get(file.path);
    if (!previous) {
      byPath.set(file.path, { ...file });
      continue;
    }
    byPath.set(file.path, {
      ...previous,
      ...(file.kind !== undefined ? { kind: file.kind } : {}),
      ...(file.additions !== undefined ? { additions: file.additions } : {}),
      ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
    });
  }
  return Array.from(byPath.values()).toSorted((a, b) => a.path.localeCompare(b.path));
}

export class PersistenceService extends EventEmitter<PersistenceServiceEvents> {
  private readonly stateDb: StateDb;
  private readonly db: StateDb["db"];
  private readonly sessionThreadIds = new Map<string, string>();
  private readonly runtimeThreadIds = new Map<string, string>();

  constructor(options: PersistenceServiceOptions) {
    super();
    this.stateDb = new StateDb({ dbPath: options.dbPath });
    this.db = this.stateDb.db;
    if (options.legacyProjectsJsonPath) {
      this.importProjectsJsonIfNeeded(options.legacyProjectsJsonPath);
    }
  }

  close(): void {
    this.stateDb.close();
  }

  getAppSettings(): AppSettings {
    const metadataValue = this.readMetadata(METADATA_KEY_APP_SETTINGS);
    const parsed = appSettingsSchema.safeParse(metadataValue);
    if (parsed.success) {
      return parsed.data;
    }
    return appSettingsSchema.parse({});
  }

  updateAppSettings(raw: AppSettingsUpdateInput): AppSettings {
    const patch = appSettingsUpdateInputSchema.parse(raw);
    const next = appSettingsSchema.parse({
      ...this.getAppSettings(),
      ...patch,
    });
    this.writeMetadata(METADATA_KEY_APP_SETTINGS, next);
    return next;
  }

  listProjects(): ProjectListResult {
    const rows = this.db
      .prepare(
        "SELECT data_json FROM documents WHERE kind = 'project' ORDER BY updated_at DESC, created_at DESC;",
      )
      .all() as Array<{ data_json: string }>;

    const projects: StateProject[] = [];
    for (const row of rows) {
      const parsed = this.parseJson(row.data_json, stateProjectSchema);
      if (parsed) {
        projects.push(parsed);
      }
    }
    return projects;
  }

  addProject(raw: ProjectAddInput): ProjectAddResult {
    const input = projectAddInputSchema.parse(raw);
    const normalizedCwd = normalizeCwd(input.cwd);
    if (!isDirectory(normalizedCwd)) {
      throw new Error(`Project path does not exist: ${normalizedCwd}`);
    }

    const existing = this.findProjectByNormalizedCwd(normalizedCwd);
    if (existing) {
      return { project: existing, created: false };
    }

    const now = nowIso();
    const project = stateProjectSchema.parse({
      id: randomUUID(),
      cwd: normalizedCwd,
      name: inferProjectName(normalizedCwd),
      scripts: [],
      createdAt: now,
      updatedAt: now,
    });

    this.withTransaction((pendingEvents) => {
      this.upsertProjectDocument(project);
      this.appendStateEvent(pendingEvents, "project.upsert", project.id, { project }, project.updatedAt);
    });

    return { project, created: true };
  }

  removeProject(raw: ProjectRemoveInput): void {
    const input = projectRemoveInputSchema.parse(raw);
    const existingProject = this.getProjectById(input.id);
    if (!existingProject) {
      return;
    }

    this.withTransaction((pendingEvents) => {
      const threadRows = this.db
        .prepare("SELECT data_json FROM documents WHERE kind = 'thread' AND project_id = ?;")
        .all(input.id) as Array<{ data_json: string }>;
      const threadIds: string[] = [];
      for (const row of threadRows) {
        const parsed = this.parseJson(row.data_json, stateThreadSchema);
        if (parsed) {
          threadIds.push(parsed.id);
        }
      }

      this.db.prepare("DELETE FROM documents WHERE project_id = ?;").run(input.id);

      const eventTime = nowIso();
      for (const threadId of threadIds) {
        this.appendStateEvent(pendingEvents, "thread.delete", threadId, { threadId }, eventTime);
      }
      this.appendStateEvent(
        pendingEvents,
        "project.delete",
        input.id,
        { projectId: input.id },
        eventTime,
      );
    });
  }

  updateProjectScripts(raw: ProjectUpdateScriptsInput): ProjectUpdateScriptsResult {
    const input = projectUpdateScriptsInputSchema.parse(raw);
    const existing = this.getProjectById(input.id);
    if (!existing) {
      throw new Error(`Project not found: ${input.id}`);
    }

    const nextScripts = normalizeProjectScripts(projectScriptsSchema.parse(input.scripts));
    const updatedProject = stateProjectSchema.parse({
      ...existing,
      scripts: nextScripts,
      updatedAt: nowIso(),
    });

    this.withTransaction((pendingEvents) => {
      this.upsertProjectDocument(updatedProject);
      this.appendStateEvent(
        pendingEvents,
        "project.upsert",
        updatedProject.id,
        { project: updatedProject },
        updatedProject.updatedAt,
      );
    });

    return {
      project: updatedProject,
    };
  }

  createThread(raw: ThreadsCreateInput): ThreadsUpdateResult {
    const input = threadsCreateInputSchema.parse(raw);
    const project = this.getProjectById(input.projectId);
    if (!project) {
      throw new Error(`Project not found: ${input.projectId}`);
    }

    const now = nowIso();
    const terminalIds = normalizeTerminalIds(input.terminalIds ?? [DEFAULT_TERMINAL_ID]);
    const activeTerminalId = input.activeTerminalId ?? terminalIds[0] ?? DEFAULT_TERMINAL_ID;
    const thread = normalizeThread(
      stateThreadSchema.parse({
        id: randomUUID(),
        codexThreadId: null,
        projectId: project.id,
        title: input.title ?? "New thread",
        model: input.model ?? DEFAULT_MODEL,
        terminalOpen: input.terminalOpen ?? false,
        terminalHeight: input.terminalHeight ?? DEFAULT_TERMINAL_HEIGHT,
        terminalIds,
        activeTerminalId,
        terminalGroups: input.terminalGroups ?? [],
        activeTerminalGroupId:
          input.activeTerminalGroupId ?? fallbackGroupId(activeTerminalId),
        createdAt: now,
        updatedAt: now,
        lastVisitedAt: now,
        branch: input.branch ?? null,
        worktreePath: input.worktreePath ?? null,
      }),
    );

    this.withTransaction((pendingEvents) => {
      this.upsertThreadDocument(thread);
      this.appendStateEvent(pendingEvents, "thread.upsert", thread.id, { thread }, thread.updatedAt);
    });

    return threadsUpdateResultSchema.parse({ thread });
  }

  updateThreadTitle(raw: ThreadsUpdateTitleInput): ThreadsUpdateResult {
    const input = threadsUpdateTitleInputSchema.parse(raw);
    return this.updateThreadWith(input.threadId, (thread) => ({
      ...thread,
      title: input.title,
      updatedAt: nowIso(),
    }));
  }

  updateThreadModel(raw: ThreadsUpdateModelInput): ThreadsUpdateResult {
    const input = threadsUpdateModelInputSchema.parse(raw);
    return this.updateThreadWith(input.threadId, (thread) => ({
      ...thread,
      model: input.model,
      updatedAt: nowIso(),
    }));
  }

  markThreadVisited(raw: ThreadsMarkVisitedInput): ThreadsUpdateResult {
    const input = threadsMarkVisitedInputSchema.parse(raw);
    const visitedAt = input.visitedAt ?? nowIso();
    return this.updateThreadWith(input.threadId, (thread) => ({
      ...thread,
      lastVisitedAt: visitedAt,
      updatedAt: nowIso(),
    }));
  }

  updateThreadBranch(raw: ThreadsUpdateBranchInput): ThreadsUpdateResult {
    const input = threadsUpdateBranchInputSchema.parse(raw);
    return this.updateThreadWith(input.threadId, (thread) => ({
      ...thread,
      branch: input.branch,
      worktreePath: input.worktreePath,
      updatedAt: nowIso(),
    }));
  }

  updateThreadTerminalState(raw: ThreadsUpdateTerminalStateInput): ThreadsUpdateResult {
    const input = threadsUpdateTerminalStateInputSchema.parse(raw);
    return this.updateThreadWith(input.threadId, (thread) =>
      normalizeThread({
        ...thread,
        terminalOpen: input.terminalOpen ?? thread.terminalOpen,
        terminalHeight: input.terminalHeight ?? thread.terminalHeight,
        terminalIds: input.terminalIds ?? thread.terminalIds,
        runningTerminalIds: input.runningTerminalIds ?? thread.runningTerminalIds,
        activeTerminalId: input.activeTerminalId ?? thread.activeTerminalId,
        terminalGroups: input.terminalGroups ?? thread.terminalGroups,
        activeTerminalGroupId: input.activeTerminalGroupId ?? thread.activeTerminalGroupId,
        updatedAt: nowIso(),
      }),
    );
  }

  deleteThread(raw: ThreadsDeleteInput): void {
    const input = threadsDeleteInputSchema.parse(raw);
    const thread = this.getThreadById(input.threadId);
    if (!thread) {
      return;
    }

    this.withTransaction((pendingEvents) => {
      this.db.prepare("DELETE FROM documents WHERE thread_id = ?;").run(thread.id);
      this.db
        .prepare("DELETE FROM documents WHERE id = ? AND kind = 'thread';")
        .run(threadDocId(thread.id));
      this.appendStateEvent(pendingEvents, "thread.delete", thread.id, { threadId: thread.id }, nowIso());
    });
  }

  loadSnapshot(): StateBootstrapResult {
    const projects = this.listProjects();
    const threadRows = this.db
      .prepare(
        "SELECT data_json FROM documents WHERE kind = 'thread' ORDER BY updated_at DESC, created_at DESC;",
      )
      .all() as Array<{ data_json: string }>;

    const threads: StateBootstrapThread[] = [];
    for (const row of threadRows) {
      const parsedThread = this.parseJson(row.data_json, stateThreadSchema);
      if (!parsedThread) continue;
      const messages = this.listMessagesForThread(parsedThread.id);
      const turnDiffSummaries = this.listTurnSummariesForThread(parsedThread.id);
      threads.push({
        ...parsedThread,
        turnDiffSummaries,
        messages,
      });
    }

    const lastStateSeq = this.readLastStateSeq();
    return stateBootstrapResultSchema.parse({
      projects,
      threads,
      lastStateSeq,
    });
  }

  catchUp(raw: StateCatchUpInput): StateCatchUpResult {
    const input = stateCatchUpInputSchema.parse(raw);
    const rows = this.db
      .prepare(
        "SELECT seq, event_type, entity_id, payload_json, created_at FROM state_events WHERE seq > ? ORDER BY seq ASC;",
      )
      .all(input.afterSeq) as unknown as StateEventRow[];

    const events: StateEvent[] = [];
    for (const row of rows) {
      const payload = this.tryParseJson(row.payload_json);
      events.push(
        stateEventSchema.parse({
          seq: row.seq,
          eventType: row.event_type,
          entityId: row.entity_id,
          payload,
          createdAt: row.created_at,
        }),
      );
    }

    return stateCatchUpResultSchema.parse({
      events,
      lastStateSeq: this.readLastStateSeq(),
    });
  }

  listMessages(raw: StateListMessagesInput): StateListMessagesResult {
    const input = stateListMessagesInputSchema.parse(raw);
    const rows = this.db
      .prepare(
        "SELECT data_json FROM documents WHERE kind = 'message' AND thread_id = ? ORDER BY sort_key ASC LIMIT ? OFFSET ?;",
      )
      .all(input.threadId, input.limit, input.offset) as Array<{ data_json: string }>;
    const totalRow = this.db
      .prepare("SELECT COUNT(1) AS total FROM documents WHERE kind = 'message' AND thread_id = ?;")
      .get(input.threadId) as { total: number } | undefined;
    const total = totalRow?.total ?? 0;

    const messages: StateMessage[] = [];
    for (const row of rows) {
      const parsed = this.parseJson(row.data_json, stateMessageSchema);
      if (parsed) {
        messages.push(parsed);
      }
    }

    const nextOffset = input.offset + messages.length;
    return stateListMessagesResultSchema.parse({
      messages,
      total,
      nextOffset: nextOffset < total ? nextOffset : null,
    });
  }

  importLegacyRendererState(raw: StateImportLegacyRendererStateInput): StateImportLegacyRendererStateResult {
    const input = stateImportLegacyRendererStateInputSchema.parse(raw);
    const alreadyImported = this.readMetadataBoolean(METADATA_KEY_LEGACY_RENDERER_IMPORTED);
    if (alreadyImported) {
      return { imported: false, alreadyImported: true };
    }

    this.stateDb.transaction(() => {
      const now = nowIso();
      const projectIdByCwd = new Map<string, string>();

      for (const project of input.projects) {
        const normalizedCwd = normalizeCwd(project.cwd);
        if (!isDirectory(normalizedCwd)) {
          continue;
        }
        if (projectIdByCwd.has(normalizedCwd)) {
          continue;
        }
        const existing = this.findProjectByNormalizedCwd(normalizedCwd);
        const nextProject = stateProjectSchema.parse({
          id: existing?.id ?? project.id,
          cwd: normalizedCwd,
          name: project.name.trim().length > 0 ? project.name.trim() : inferProjectName(normalizedCwd),
          scripts: normalizeProjectScripts(project.scripts),
          createdAt: project.createdAt ?? existing?.createdAt ?? now,
          updatedAt: project.updatedAt ?? now,
        });
        this.upsertProjectDocument(nextProject);
        projectIdByCwd.set(normalizedCwd, nextProject.id);
      }

      const projectIdMap = new Map<string, string>();
      for (const project of input.projects) {
        const normalizedCwd = normalizeCwd(project.cwd);
        const mappedProjectId = projectIdByCwd.get(normalizedCwd);
        if (!mappedProjectId) continue;
        projectIdMap.set(project.id, mappedProjectId);
      }

      for (const thread of input.threads) {
        const mappedProjectId = projectIdMap.get(thread.projectId);
        if (!mappedProjectId) continue;

        const normalizedThread = normalizeThread(
          stateThreadSchema.parse({
            id: thread.id,
            codexThreadId: thread.codexThreadId ?? null,
            projectId: mappedProjectId,
            title: thread.title,
            model: thread.model,
            terminalOpen: thread.terminalOpen,
            terminalHeight: thread.terminalHeight,
            terminalIds: thread.terminalIds,
            activeTerminalId: thread.activeTerminalId,
            terminalGroups: thread.terminalGroups,
            activeTerminalGroupId:
              thread.activeTerminalGroupId ?? fallbackGroupId(thread.activeTerminalId),
            createdAt: thread.createdAt,
            updatedAt: thread.lastVisitedAt ?? thread.createdAt,
            lastVisitedAt: thread.lastVisitedAt,
            branch: thread.branch ?? null,
            worktreePath: thread.worktreePath ?? null,
            turnDiffSummaries: [],
          }),
        );
        this.upsertThreadDocument(normalizedThread);

        const sortedMessages = [...thread.messages].toSorted((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        for (const message of sortedMessages) {
          const messageRecord = stateMessageSchema.parse({
            id: message.id,
            threadId: normalizedThread.id,
            role: message.role,
            text: message.text,
            attachments: message.attachments,
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
            streaming: false,
          });
          this.upsertMessageDocument(normalizedThread, messageRecord);
        }

        for (const summary of thread.turnDiffSummaries) {
          const parsedSummary = stateTurnSummarySchema.parse(summary);
          this.upsertTurnSummaryDocument(normalizedThread, parsedSummary);
        }
      }

      this.writeMetadata(
        METADATA_KEY_LEGACY_RENDERER_IMPORTED,
        {
          importedAt: nowIso(),
          threadCount: input.threads.length,
          projectCount: input.projects.length,
        },
        true,
      );
    });

    return {
      imported: true,
      alreadyImported: false,
    };
  }

  bindSessionToThread(sessionId: string, threadId: string, runtimeThreadId?: string | null): void {
    if (!sessionId || !threadId) return;
    this.sessionThreadIds.set(sessionId, threadId);
    if (!runtimeThreadId) {
      return;
    }
    this.runtimeThreadIds.set(runtimeThreadId, threadId);
    this.updateThreadWith(threadId, (thread) => ({
      ...thread,
      codexThreadId: runtimeThreadId,
      updatedAt: nowIso(),
    }));
  }

  unbindSession(sessionId: string): void {
    this.sessionThreadIds.delete(sessionId);
  }

  persistUserMessageForTurn(raw: ProviderSendTurnInput): void {
    const input = raw;
    const threadId = this.sessionThreadIds.get(input.sessionId);
    if (!threadId) {
      return;
    }

    const thread = this.getThreadById(threadId);
    if (!thread) {
      return;
    }

    const messageId = input.clientMessageId ?? randomUUID();
    const text = input.clientMessageText ?? input.input ?? "";
    const createdAt = nowIso();
    const inputAttachments = input.attachments ?? [];
    const attachments =
      inputAttachments.length > 0
        ? inputAttachments.map((attachment, index) => ({
            type: "image" as const,
            id: `${messageId}:image:${index + 1}`,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          }))
        : undefined;
    const message = stateMessageSchema.parse({
      id: messageId,
      threadId,
      role: "user",
      text,
      ...(attachments ? { attachments } : {}),
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    });

    this.withTransaction((pendingEvents) => {
      this.upsertMessageDocument(thread, message);
      this.appendStateEvent(
        pendingEvents,
        "message.upsert",
        `${thread.id}:${message.id}`,
        { threadId: thread.id, message },
        message.updatedAt,
      );
    });
  }

  ingestProviderEvent(event: ProviderEvent): void {
    this.withTransaction((pendingEvents) => {
      const insertResult = this.insertProviderEvent(event);
      if (!insertResult.inserted) {
        return;
      }

      const localThreadId = this.resolveThreadIdForEvent(event, insertResult.runtimeThreadId);
      if (!localThreadId) {
        return;
      }

      const thread = this.getThreadById(localThreadId);
      if (!thread) {
        return;
      }

      let nextThread = thread;
      const runtimeThreadId = insertResult.runtimeThreadId;
      if (runtimeThreadId && nextThread.codexThreadId !== runtimeThreadId) {
        this.runtimeThreadIds.set(runtimeThreadId, nextThread.id);
        nextThread = {
          ...nextThread,
          codexThreadId: runtimeThreadId,
          updatedAt: event.createdAt,
        };
        this.upsertThreadDocument(nextThread);
        this.appendStateEvent(
          pendingEvents,
          "thread.upsert",
          nextThread.id,
          { thread: nextThread },
          nextThread.updatedAt,
        );
      }

      if (event.method === "turn/started") {
        const turnId = parseTurnIdFromEvent(event);
        nextThread = {
          ...nextThread,
          latestTurnId: turnId ?? nextThread.latestTurnId,
          latestTurnStartedAt: event.createdAt,
          latestTurnCompletedAt: undefined,
          latestTurnDurationMs: undefined,
          updatedAt: event.createdAt,
        };
        this.upsertThreadDocument(nextThread);
        this.appendStateEvent(
          pendingEvents,
          "thread.upsert",
          nextThread.id,
          { thread: nextThread },
          nextThread.updatedAt,
        );
      }

      if (event.method === "item/started") {
        const assistantItemId = parseAssistantItemId(event);
        if (assistantItemId) {
          const payload = asObject(event.payload);
          const item = asObject(payload?.item);
          const seedText = asString(item?.text) ?? "";
          const assistantMessage = stateMessageSchema.parse({
            id: assistantItemId,
            threadId: nextThread.id,
            role: "assistant",
            text: seedText,
            createdAt: event.createdAt,
            updatedAt: event.createdAt,
            streaming: true,
          });
          this.upsertMessageDocument(nextThread, assistantMessage);
          this.appendStateEvent(
            pendingEvents,
            "message.upsert",
            `${nextThread.id}:${assistantMessage.id}`,
            { threadId: nextThread.id, message: assistantMessage },
            assistantMessage.updatedAt,
          );
        }
      }

      if (event.method === "item/agentMessage/delta") {
        const payload = asObject(event.payload);
        const messageId = event.itemId ?? asString(payload?.itemId);
        const delta = event.textDelta ?? asString(payload?.delta) ?? "";
        if (messageId && delta.length > 0) {
          const existing = this.getMessageById(nextThread.id, messageId);
          const message = stateMessageSchema.parse({
            id: messageId,
            threadId: nextThread.id,
            role: "assistant",
            text: `${existing?.text ?? ""}${delta}`,
            createdAt: existing?.createdAt ?? event.createdAt,
            updatedAt: event.createdAt,
            streaming: true,
          });
          this.upsertMessageDocument(nextThread, message);
          this.appendStateEvent(
            pendingEvents,
            "message.upsert",
            `${nextThread.id}:${message.id}`,
            { threadId: nextThread.id, message },
            message.updatedAt,
          );
        }
      }

      if (event.method === "item/completed") {
        const payload = asObject(event.payload);
        const item = asObject(payload?.item);
        if (asString(item?.type) === "agentMessage") {
          const messageId = asString(item?.id);
          if (messageId) {
            const existing = this.getMessageById(nextThread.id, messageId);
            const fullText = asString(item?.text) ?? existing?.text ?? "";
            const message = stateMessageSchema.parse({
              id: messageId,
              threadId: nextThread.id,
              role: "assistant",
              text: fullText,
              createdAt: existing?.createdAt ?? event.createdAt,
              updatedAt: event.createdAt,
              streaming: false,
            });
            this.upsertMessageDocument(nextThread, message);
            this.appendStateEvent(
              pendingEvents,
              "message.upsert",
              `${nextThread.id}:${message.id}`,
              { threadId: nextThread.id, message },
              message.updatedAt,
            );
          }
        }
      }

      if (event.method === "turn/completed") {
        const completedTurnId = parseTurnIdFromEvent(event) ?? nextThread.latestTurnId;
        const turnStatus = asString(asObject(asObject(event.payload)?.turn)?.status);
        const startedAt =
          completedTurnId && completedTurnId === nextThread.latestTurnId
            ? nextThread.latestTurnStartedAt
            : undefined;
        const durationMs =
          startedAt && !Number.isNaN(Date.parse(startedAt))
            ? Math.max(0, Date.parse(event.createdAt) - Date.parse(startedAt))
            : undefined;

        nextThread = {
          ...nextThread,
          latestTurnId: completedTurnId ?? nextThread.latestTurnId,
          latestTurnCompletedAt: event.createdAt,
          latestTurnDurationMs: durationMs,
          updatedAt: event.createdAt,
        };
        this.upsertThreadDocument(nextThread);
        this.appendStateEvent(
          pendingEvents,
          "thread.upsert",
          nextThread.id,
          { thread: nextThread },
          nextThread.updatedAt,
        );

        if (completedTurnId) {
          const summary = this.upsertTurnSummary(
            nextThread,
            completedTurnId,
            {
              completedAt: event.createdAt,
              ...(turnStatus ? { status: turnStatus } : {}),
            },
            "merge",
          );
          this.appendStateEvent(
            pendingEvents,
            "turn_summary.upsert",
            `${nextThread.id}:${summary.turnId}`,
            { threadId: nextThread.id, turnSummary: summary },
            summary.completedAt,
          );
        }

        const messages = this.listMessagesForThread(nextThread.id);
        for (const message of messages) {
          if (!message.streaming) continue;
          const completedMessage = stateMessageSchema.parse({
            ...message,
            streaming: false,
            updatedAt: event.createdAt,
          });
          this.upsertMessageDocument(nextThread, completedMessage);
          this.appendStateEvent(
            pendingEvents,
            "message.upsert",
            `${nextThread.id}:${completedMessage.id}`,
            { threadId: nextThread.id, message: completedMessage },
            completedMessage.updatedAt,
          );
        }
      }

      if (event.method === "turn/diff/updated") {
        const turnId = parseTurnIdFromEvent(event);
        const diff = asString(asObject(event.payload)?.diff);
        if (turnId && diff) {
          const summary = this.upsertTurnSummary(
            nextThread,
            turnId,
            {
              completedAt: event.createdAt,
              files: summarizeUnifiedDiff(diff),
            },
            "merge",
          );
          this.appendStateEvent(
            pendingEvents,
            "turn_summary.upsert",
            `${nextThread.id}:${summary.turnId}`,
            { threadId: nextThread.id, turnSummary: summary },
            summary.completedAt,
          );
        }
      }
    });
  }

  persistTurnDiffSummaryFromCheckpoint(input: {
    sessionId: string;
    turnId: string | null;
    runtimeThreadId: string;
    checkpointTurnCount: number;
    completedAt: string;
    status?: string;
    diff: string;
  }): void {
    if (!input.turnId) {
      return;
    }
    const turnId = input.turnId;

    const localThreadId =
      this.sessionThreadIds.get(input.sessionId) ??
      this.runtimeThreadIds.get(input.runtimeThreadId) ??
      this.findThreadByRuntimeThreadId(input.runtimeThreadId)?.id;
    if (!localThreadId) {
      return;
    }
    const thread = this.getThreadById(localThreadId);
    if (!thread) {
      return;
    }

    this.withTransaction((pendingEvents) => {
      const summary = this.upsertTurnSummary(
        thread,
        turnId,
        {
          completedAt: input.completedAt,
          ...(input.status ? { status: input.status } : {}),
          checkpointTurnCount: input.checkpointTurnCount,
          files: summarizeUnifiedDiff(input.diff),
        },
        "replace",
      );
      this.appendStateEvent(
        pendingEvents,
        "turn_summary.upsert",
        `${thread.id}:${summary.turnId}`,
        { threadId: thread.id, turnSummary: summary },
        summary.completedAt,
      );
    });
  }

  applyCheckpointRevert(input: {
    sessionId: string;
    runtimeThreadId: string;
    turnCount: number;
    messageCount: number;
  }): void {
    const threadId =
      this.sessionThreadIds.get(input.sessionId) ??
      this.runtimeThreadIds.get(input.runtimeThreadId) ??
      this.findThreadByRuntimeThreadId(input.runtimeThreadId)?.id;
    if (!threadId) {
      return;
    }
    const thread = this.getThreadById(threadId);
    if (!thread) {
      return;
    }

    this.withTransaction((pendingEvents) => {
      const messages = this.listMessagesForThread(thread.id);
      if (messages.length > input.messageCount) {
        for (let index = input.messageCount; index < messages.length; index += 1) {
          const message = messages[index];
          if (!message) continue;
          this.db
            .prepare("DELETE FROM documents WHERE id = ? AND kind = 'message';")
            .run(messageDocId(thread.id, message.id));
          this.appendStateEvent(
            pendingEvents,
            "message.delete",
            `${thread.id}:${message.id}`,
            { threadId: thread.id, messageId: message.id },
            nowIso(),
          );
        }
      }

      const summaries = this.listTurnSummariesForThread(thread.id);
      for (const summary of summaries) {
        if (
          typeof summary.checkpointTurnCount === "number" &&
          summary.checkpointTurnCount > input.turnCount
        ) {
          this.db
            .prepare("DELETE FROM documents WHERE id = ? AND kind = 'turn_summary';")
            .run(turnSummaryDocId(thread.id, summary.turnId));
          this.appendStateEvent(
            pendingEvents,
            "turn_summary.delete",
            `${thread.id}:${summary.turnId}`,
            { threadId: thread.id, turnId: summary.turnId },
            nowIso(),
          );
        }
      }

      const revertedThread = stateThreadSchema.parse({
        ...thread,
        codexThreadId: input.runtimeThreadId,
        latestTurnId: undefined,
        latestTurnStartedAt: undefined,
        latestTurnCompletedAt: undefined,
        latestTurnDurationMs: undefined,
        updatedAt: nowIso(),
        lastVisitedAt: nowIso(),
      });
      this.upsertThreadDocument(revertedThread);
      this.appendStateEvent(
        pendingEvents,
        "thread.upsert",
        revertedThread.id,
        { thread: revertedThread },
        revertedThread.updatedAt,
      );
    });
  }

  private updateThreadWith(
    threadId: string,
    updater: (thread: StateThread) => StateThread,
  ): ThreadsUpdateResult {
    const existing = this.getThreadById(threadId);
    if (!existing) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    const nextThread = normalizeThread(stateThreadSchema.parse(updater(existing)));
    this.withTransaction((pendingEvents) => {
      this.upsertThreadDocument(nextThread);
      this.appendStateEvent(
        pendingEvents,
        "thread.upsert",
        nextThread.id,
        { thread: nextThread },
        nextThread.updatedAt,
      );
    });

    return threadsUpdateResultSchema.parse({ thread: nextThread });
  }

  private importProjectsJsonIfNeeded(projectsJsonPath: string): void {
    const importedAlready = this.readMetadataBoolean(METADATA_KEY_PROJECTS_JSON_IMPORTED);
    if (importedAlready) {
      return;
    }

    const normalizedPath = path.resolve(projectsJsonPath);
    const exists = fs.existsSync(normalizedPath);
    if (!exists) {
      this.writeMetadata(METADATA_KEY_PROJECTS_JSON_IMPORTED, { importedAt: nowIso(), source: null });
      return;
    }

    let importedCount = 0;
    this.stateDb.transaction(() => {
      try {
        const raw = fs.readFileSync(normalizedPath, "utf8");
        const payload = JSON.parse(raw) as { projects?: unknown };
        const candidates = Array.isArray(payload.projects) ? payload.projects : [];
        for (const candidate of candidates) {
          const parsed = projectRecordSchema.safeParse(candidate);
          if (!parsed.success) continue;
          const project = parsed.data;
          const normalizedCwd = normalizeCwd(project.cwd);
          if (!isDirectory(normalizedCwd)) continue;

          const existing = this.findProjectByNormalizedCwd(normalizedCwd);
          const nextProject = stateProjectSchema.parse({
            id: existing?.id ?? project.id,
            cwd: normalizedCwd,
            name: project.name.trim().length > 0 ? project.name.trim() : inferProjectName(normalizedCwd),
            scripts: normalizeProjectScripts(project.scripts),
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          });
          this.upsertProjectDocument(nextProject);
          importedCount += 1;
        }
      } catch {
        // Ignore malformed legacy file.
      }

      this.writeMetadata(
        METADATA_KEY_PROJECTS_JSON_IMPORTED,
        { importedAt: nowIso(), source: normalizedPath, importedCount },
        true,
      );
    });

    try {
      const backupPath = `${normalizedPath}.bak.${Date.now()}`;
      fs.renameSync(normalizedPath, backupPath);
    } catch {
      // Best-effort backup move.
    }
  }

  private readLastStateSeq(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM state_events;")
      .get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  private withTransaction<T>(fn: (pendingEvents: StateEvent[]) => T): T {
    const pendingEvents: StateEvent[] = [];
    const result = this.stateDb.transaction(() => fn(pendingEvents));
    for (const event of pendingEvents) {
      this.emit("stateEvent", event);
    }
    return result;
  }

  private appendStateEvent(
    pendingEvents: StateEvent[],
    eventType: string,
    entityId: string,
    payload: unknown,
    createdAt: string,
  ): void {
    const result = this.db
      .prepare(
        "INSERT INTO state_events (event_type, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?);",
      )
      .run(eventType, entityId, JSON.stringify(payload), createdAt) as {
      lastInsertRowid?: number | bigint;
    };
    const seq = toSafeInteger(result.lastInsertRowid, 0);
    pendingEvents.push(
      stateEventSchema.parse({
        seq,
        eventType,
        entityId,
        payload,
        createdAt,
      }),
    );
  }

  private upsertProjectDocument(project: StateProject): void {
    this.upsertDocument({
      id: projectDocId(project.id),
      kind: "project",
      projectId: project.id,
      threadId: null,
      sortKey: null,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      data: project,
    });
  }

  private upsertThreadDocument(thread: StateThread): void {
    this.upsertDocument({
      id: threadDocId(thread.id),
      kind: "thread",
      projectId: thread.projectId,
      threadId: thread.id,
      sortKey: null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      data: {
        ...thread,
        // Turn summaries are stored in dedicated documents to keep thread rows small.
        turnDiffSummaries: [],
      },
    });
  }

  private upsertMessageDocument(thread: StateThread, message: StateMessage): void {
    const existingRow = this.getDocumentRowById(messageDocId(thread.id, message.id));
    const sortKey =
      existingRow?.sort_key ??
      this.readNextSortKey("message", thread.id);
    this.upsertDocument({
      id: messageDocId(thread.id, message.id),
      kind: "message",
      projectId: thread.projectId,
      threadId: thread.id,
      sortKey,
      createdAt: existingRow?.created_at ?? message.createdAt,
      updatedAt: message.updatedAt,
      data: message,
    });
  }

  private upsertTurnSummaryDocument(thread: StateThread, summary: StateTurnSummary): void {
    this.upsertDocument({
      id: turnSummaryDocId(thread.id, summary.turnId),
      kind: "turn_summary",
      projectId: thread.projectId,
      threadId: thread.id,
      sortKey:
        summary.checkpointTurnCount ??
        toSafeInteger(Date.parse(summary.completedAt), 0),
      createdAt: summary.completedAt,
      updatedAt: summary.completedAt,
      data: summary,
    });
  }

  private upsertTurnSummary(
    thread: StateThread,
    turnId: string,
    patch: {
      completedAt: string;
      status?: string;
      assistantMessageId?: string;
      checkpointTurnCount?: number;
      files?: StateTurnDiffFileChange[];
    },
    mode: "merge" | "replace",
  ): StateTurnSummary {
    const existing = this.getTurnSummaryByTurnId(thread.id, turnId);
    const nextSummary = stateTurnSummarySchema.parse({
      turnId,
      completedAt: patch.completedAt || existing?.completedAt || nowIso(),
      ...(patch.status ?? existing?.status ? { status: patch.status ?? existing?.status } : {}),
      ...(patch.assistantMessageId ?? existing?.assistantMessageId
        ? { assistantMessageId: patch.assistantMessageId ?? existing?.assistantMessageId }
        : {}),
      ...(patch.checkpointTurnCount ?? existing?.checkpointTurnCount
        ? { checkpointTurnCount: patch.checkpointTurnCount ?? existing?.checkpointTurnCount }
        : {}),
      files:
        patch.files === undefined
          ? (existing?.files ?? [])
          : mode === "replace"
            ? patch.files
            : mergeTurnSummaryFiles(existing?.files ?? [], patch.files),
    });
    this.upsertTurnSummaryDocument(thread, nextSummary);
    return nextSummary;
  }

  private findProjectByNormalizedCwd(normalizedCwd: string): StateProject | null {
    const projects = this.listProjects();
    for (const project of projects) {
      if (normalizeCwd(project.cwd) === normalizedCwd) {
        return project;
      }
    }
    return null;
  }

  private getProjectById(projectId: string): StateProject | null {
    const row = this.getDocumentRowById(projectDocId(projectId));
    if (!row) return null;
    return this.parseJson(row.data_json, stateProjectSchema);
  }

  private getThreadById(threadId: string): StateThread | null {
    const row = this.getDocumentRowById(threadDocId(threadId));
    if (!row) return null;
    const parsed = this.parseJson(row.data_json, stateThreadSchema);
    return parsed ? normalizeThread(parsed) : null;
  }

  private findThreadByRuntimeThreadId(runtimeThreadId: string): StateThread | null {
    const row = this.db
      .prepare(
        "SELECT data_json FROM documents WHERE kind = 'thread' AND json_extract(data_json, '$.codexThreadId') = ? LIMIT 1;",
      )
      .get(runtimeThreadId) as { data_json: string } | undefined;
    if (!row) return null;
    const parsed = this.parseJson(row.data_json, stateThreadSchema);
    return parsed ? normalizeThread(parsed) : null;
  }

  private getMessageById(threadId: string, messageId: string): StateMessage | null {
    const row = this.getDocumentRowById(messageDocId(threadId, messageId));
    if (!row) return null;
    return this.parseJson(row.data_json, stateMessageSchema);
  }

  private getTurnSummaryByTurnId(threadId: string, turnId: string): StateTurnSummary | null {
    const row = this.getDocumentRowById(turnSummaryDocId(threadId, turnId));
    if (!row) return null;
    return this.parseJson(row.data_json, stateTurnSummarySchema);
  }

  private listMessagesForThread(threadId: string): StateMessage[] {
    const rows = this.db
      .prepare(
        "SELECT data_json FROM documents WHERE kind = 'message' AND thread_id = ? ORDER BY sort_key ASC;",
      )
      .all(threadId) as Array<{ data_json: string }>;
    const messages: StateMessage[] = [];
    for (const row of rows) {
      const parsed = this.parseJson(row.data_json, stateMessageSchema);
      if (parsed) {
        messages.push(parsed);
      }
    }
    return messages;
  }

  private listTurnSummariesForThread(threadId: string): StateTurnSummary[] {
    const rows = this.db
      .prepare(
        "SELECT data_json FROM documents WHERE kind = 'turn_summary' AND thread_id = ? ORDER BY sort_key DESC, updated_at DESC;",
      )
      .all(threadId) as Array<{ data_json: string }>;
    const summaries: StateTurnSummary[] = [];
    for (const row of rows) {
      const parsed = this.parseJson(row.data_json, stateTurnSummarySchema);
      if (parsed) {
        summaries.push(parsed);
      }
    }
    return summaries;
  }

  private upsertDocument(input: UpsertDocumentInput): void {
    this.db
      .prepare(
        `INSERT INTO documents (
          id,
          kind,
          project_id,
          thread_id,
          sort_key,
          schema_version,
          created_at,
          updated_at,
          data_json
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          sort_key = excluded.sort_key,
          schema_version = excluded.schema_version,
          updated_at = excluded.updated_at,
          data_json = excluded.data_json;`,
      )
      .run(
        input.id,
        input.kind,
        input.projectId,
        input.threadId,
        input.sortKey,
        input.createdAt,
        input.updatedAt,
        JSON.stringify(input.data),
      );
  }

  private getDocumentRowById(id: string): DocumentRow | null {
    const row = this.db
      .prepare(
        "SELECT id, kind, project_id, thread_id, sort_key, created_at, updated_at, data_json FROM documents WHERE id = ? LIMIT 1;",
      )
      .get(id) as DocumentRow | undefined;
    return row ?? null;
  }

  private readNextSortKey(kind: "message" | "turn_summary", threadId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sort_key), 0) + 1 AS next_sort_key FROM documents WHERE kind = ? AND thread_id = ?;",
      )
      .get(kind, threadId) as { next_sort_key: number } | undefined;
    return row?.next_sort_key ?? 1;
  }

  private resolveThreadIdForEvent(event: ProviderEvent, runtimeThreadId: string | null): string | null {
    const bySession = this.sessionThreadIds.get(event.sessionId);
    if (bySession) {
      if (runtimeThreadId) {
        this.runtimeThreadIds.set(runtimeThreadId, bySession);
      }
      return bySession;
    }

    if (runtimeThreadId) {
      const fromRuntimeMap = this.runtimeThreadIds.get(runtimeThreadId);
      if (fromRuntimeMap) {
        this.sessionThreadIds.set(event.sessionId, fromRuntimeMap);
        return fromRuntimeMap;
      }
      const fromThreadDoc = this.findThreadByRuntimeThreadId(runtimeThreadId);
      if (fromThreadDoc) {
        this.runtimeThreadIds.set(runtimeThreadId, fromThreadDoc.id);
        this.sessionThreadIds.set(event.sessionId, fromThreadDoc.id);
        return fromThreadDoc.id;
      }
    }

    return null;
  }

  private insertProviderEvent(event: ProviderEvent): ProviderEventInsertResult {
    const runtimeThreadId = event.threadId ?? parseThreadIdFromEventPayload(event.payload);
    const payloadJson = event.payload === undefined ? null : JSON.stringify(event.payload);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO provider_events (
          id,
          session_id,
          provider,
          kind,
          method,
          thread_id,
          turn_id,
          item_id,
          request_id,
          request_kind,
          text_delta,
          message,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      )
      .run(
        event.id,
        event.sessionId,
        event.provider,
        event.kind,
        event.method,
        runtimeThreadId,
        event.turnId ?? null,
        event.itemId ?? null,
        event.requestId ?? null,
        event.requestKind ?? null,
        event.textDelta ?? null,
        event.message ?? null,
        payloadJson,
        event.createdAt,
      ) as { changes?: number | bigint };
    return {
      inserted: toSafeInteger(result.changes, 0) > 0,
      runtimeThreadId: runtimeThreadId ?? null,
    };
  }

  private parseJson<T>(json: string, schema: SafeParseSchema<T>): T | null {
    const candidate = this.tryParseJson(json);
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  }

  private tryParseJson(json: string): unknown {
    try {
      return JSON.parse(json) as unknown;
    } catch {
      return null;
    }
  }

  private readMetadataBoolean(key: string): boolean {
    const value = this.readMetadata(key);
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value === "boolean") {
      return value;
    }
    const record = asObject(value);
    if (!record) {
      return true;
    }
    const explicit = record.value;
    if (typeof explicit === "boolean") {
      return explicit;
    }
    return true;
  }

  private readMetadata(key: string): unknown {
    const row = this.db
      .prepare("SELECT value_json FROM metadata WHERE key = ? LIMIT 1;")
      .get(key) as { value_json: string } | undefined;
    if (!row) {
      return null;
    }
    return this.tryParseJson(row.value_json);
  }

  private writeMetadata(key: string, value: unknown, inTransaction = false): void {
    const write = () => {
      this.db
        .prepare(
          "INSERT INTO metadata (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json;",
        )
        .run(key, JSON.stringify(value));
    };
    if (inTransaction) {
      write();
      return;
    }
    this.stateDb.transaction(write);
  }
}
