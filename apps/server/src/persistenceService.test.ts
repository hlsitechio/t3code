import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderEvent } from "@t3tools/contracts";
import { PersistenceService } from "./persistenceService";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("PersistenceService", () => {
  it("stores app settings in metadata with partial updates", () => {
    const stateDir = makeTempDir("t3code-persistence-settings-state-");
    const dbPath = path.join(stateDir, "state.sqlite");
    const service = new PersistenceService({ dbPath });

    expect(service.getAppSettings()).toEqual({
      codexBinaryPath: "",
      codexHomePath: "",
    });

    expect(
      service.updateAppSettings({
        codexBinaryPath: "  /opt/codex/bin/codex  ",
      }),
    ).toEqual({
      codexBinaryPath: "/opt/codex/bin/codex",
      codexHomePath: "",
    });

    expect(
      service.updateAppSettings({
        codexHomePath: "  /Users/theo/.codex  ",
      }),
    ).toEqual({
      codexBinaryPath: "/opt/codex/bin/codex",
      codexHomePath: "/Users/theo/.codex",
    });

    service.close();

    const reopened = new PersistenceService({ dbPath });
    expect(reopened.getAppSettings()).toEqual({
      codexBinaryPath: "/opt/codex/bin/codex",
      codexHomePath: "/Users/theo/.codex",
    });
    reopened.close();
  });

  it("persists projects/threads/messages and serves bootstrap + catch-up", () => {
    const stateDir = makeTempDir("t3code-persistence-state-");
    const projectDir = makeTempDir("t3code-persistence-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });

    const addedProject = service.addProject({ cwd: projectDir });
    expect(addedProject.created).toBe(true);

    const createdThread = service.createThread({
      projectId: addedProject.project.id,
      title: "Thread 1",
      model: "gpt-5.3-codex",
    }).thread;

    service.bindSessionToThread("sess-1", createdThread.id, "runtime-thread-1");
    service.persistUserMessageForTurn({
      sessionId: "sess-1",
      clientMessageId: "msg-user-1",
      clientMessageText: "hello world",
      input: "hello world",
      attachments: [],
    });

    const baseEvent: Omit<ProviderEvent, "id" | "createdAt" | "method" | "payload"> = {
      kind: "notification",
      provider: "codex",
      sessionId: "sess-1",
    };

    service.ingestProviderEvent({
      ...baseEvent,
      id: "evt-1",
      createdAt: iso(10),
      method: "item/started",
      payload: {
        item: {
          type: "agentMessage",
          id: "assistant-msg-1",
          text: "",
        },
      },
    });

    service.ingestProviderEvent({
      ...baseEvent,
      id: "evt-2",
      createdAt: iso(20),
      method: "item/agentMessage/delta",
      itemId: "assistant-msg-1",
      textDelta: "hi",
      payload: {
        itemId: "assistant-msg-1",
        delta: "hi",
      },
    });

    service.ingestProviderEvent({
      ...baseEvent,
      id: "evt-3",
      createdAt: iso(30),
      method: "item/completed",
      payload: {
        item: {
          type: "agentMessage",
          id: "assistant-msg-1",
          text: "hi there",
        },
      },
    });

    service.ingestProviderEvent({
      ...baseEvent,
      id: "evt-4",
      createdAt: iso(40),
      method: "turn/completed",
      turnId: "turn-1",
      payload: {
        turn: {
          id: "turn-1",
          status: "completed",
        },
      },
    });

    const snapshot = service.loadSnapshot();
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.threads).toHaveLength(1);
    const thread = snapshot.threads[0];
    expect(thread?.messages.map((message) => message.id)).toEqual([
      "msg-user-1",
      "assistant-msg-1",
    ]);
    expect(thread?.messages[1]?.text).toBe("hi there");
    expect(thread?.turnDiffSummaries[0]?.turnId).toBe("turn-1");

    const catchUp = service.catchUp({ afterSeq: 0 });
    expect(catchUp.events.length).toBeGreaterThan(0);
    expect(catchUp.events.every((event, index, events) => event.seq === events[index]?.seq)).toBe(
      true,
    );
    expect(catchUp.events.some((event) => event.eventType === "project.upsert")).toBe(true);
    expect(catchUp.events.some((event) => event.eventType === "thread.upsert")).toBe(true);
    expect(catchUp.events.some((event) => event.eventType === "message.upsert")).toBe(true);

    service.close();
  });

  it("stores turn diff summaries parsed from checkpoint diffs", () => {
    const stateDir = makeTempDir("t3code-persistence-diff-state-");
    const projectDir = makeTempDir("t3code-persistence-diff-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });

    const project = service.addProject({ cwd: projectDir }).project;
    const thread = service.createThread({
      projectId: project.id,
      title: "Thread 1",
      model: "gpt-5.3-codex",
    }).thread;
    service.bindSessionToThread("sess-1", thread.id, "runtime-thread-1");

    service.persistTurnDiffSummaryFromCheckpoint({
      sessionId: "sess-1",
      runtimeThreadId: "runtime-thread-1",
      turnId: "turn-1",
      checkpointTurnCount: 1,
      completedAt: "2026-02-19T00:00:00.000Z",
      status: "completed",
      diff: [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,1 +1,2 @@",
        "-console.log('a')",
        "+console.log('b')",
        "+console.log('c')",
      ].join("\n"),
    });

    const snapshot = service.loadSnapshot();
    const summary = snapshot.threads[0]?.turnDiffSummaries[0];
    expect(summary?.turnId).toBe("turn-1");
    expect(summary?.checkpointTurnCount).toBe(1);
    expect(summary?.files[0]?.path).toBe("src/app.ts");
    expect(summary?.files[0]?.additions).toBe(2);
    expect(summary?.files[0]?.deletions).toBe(1);

    service.close();
  });

  it("imports legacy renderer state once and reports idempotent re-imports", () => {
    const stateDir = makeTempDir("t3code-persistence-legacy-state-");
    const projectDir = makeTempDir("t3code-persistence-legacy-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });

    const firstImport = service.importLegacyRendererState({
      projects: [
        {
          id: "project-legacy-1",
          name: "legacy",
          cwd: projectDir,
          scripts: [],
        },
      ],
      threads: [
        {
          id: "thread-legacy-1",
          projectId: "project-legacy-1",
          title: "Imported",
          model: "gpt-5.3-codex",
          createdAt: "2026-02-19T00:00:00.000Z",
          messages: [
            {
              id: "msg-legacy-1",
              role: "user",
              text: "legacy message",
              createdAt: "2026-02-19T00:00:01.000Z",
              streaming: false,
            },
          ],
        },
      ],
    });
    expect(firstImport).toEqual({
      imported: true,
      alreadyImported: false,
    });

    const secondImport = service.importLegacyRendererState({
      projects: [],
      threads: [],
    });
    expect(secondImport).toEqual({
      imported: false,
      alreadyImported: true,
    });

    const snapshot = service.loadSnapshot();
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]?.messages).toHaveLength(1);

    service.close();
  });
});
