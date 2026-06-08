import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresProjectJobStore, StoredProjectJobQueue } from "./index.js";

const databaseUrl = process.env.HEPHAESTUS_TEST_POSTGRES_URL;

describe.runIf(databaseUrl)("PostgresProjectJobStore integration", () => {
  const tableName = `hephaestus_test_jobs_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool | undefined;
  let store: PostgresProjectJobStore;
  let currentTime = new Date("2026-01-01T00:00:00.000Z");

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    store = new PostgresProjectJobStore({ pool, tableName });
    await store.migrate();
  });

  afterAll(async () => {
    await pool?.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await pool?.end();
  });

  it("deduplicates, claims, recovers, and dead-letters jobs on live Postgres", async () => {
    const queue = new StoredProjectJobQueue(store, {
      jobLeaseMs: 1_000,
      maxAttempts: 2,
      now: () => currentTime
    });
    const competingQueue = new StoredProjectJobQueue(store, {
      jobLeaseMs: 1_000,
      maxAttempts: 2,
      now: () => currentTime
    });

    const firstJob = await queue.enqueue({
      chatId: 100,
      description: "Создай сервис книг",
      selectedModel: { id: "quality", label: "Quality" },
      idempotencyKey: "chat-100-message-42"
    });
    const duplicateJob = await queue.enqueue({
      chatId: 100,
      description: "Создай сервис книг",
      selectedModel: { id: "quality", label: "Quality" },
      idempotencyKey: "chat-100-message-42"
    });

    expect(duplicateJob.id).toBe(firstJob.id);
    await expect(queue.listByChat(100)).resolves.toHaveLength(1);

    const claims = await Promise.all([
      queue.claimNext(),
      competingQueue.claimNext()
    ]);
    const claimedJobs = claims.filter((job) => job !== null);
    expect(claimedJobs).toHaveLength(1);
    expect(claimedJobs[0]).toMatchObject({
      id: firstJob.id,
      status: "running",
      attempt: 1,
      leaseExpiresAt: "2026-01-01T00:00:01.000Z"
    });

    currentTime = new Date("2026-01-01T00:00:02.000Z");
    await expect(queue.claimNext()).resolves.toMatchObject({
      id: firstJob.id,
      status: "running",
      attempt: 2,
      leaseExpiresAt: "2026-01-01T00:00:03.000Z"
    });

    currentTime = new Date("2026-01-01T00:00:04.000Z");
    await expect(queue.claimNext()).resolves.toBeNull();
    await expect(queue.getByChat(100, firstJob.id)).resolves.toMatchObject({
      id: firstJob.id,
      status: "dead_letter",
      deadLetterAt: "2026-01-01T00:00:04.000Z",
      error: "Job lease expired after 2 attempt(s)"
    });
  });

  it("cancels and retries with durable lineage on live Postgres", async () => {
    const queue = new StoredProjectJobQueue(store, {
      now: () => new Date("2026-01-01T00:01:00.000Z")
    });
    const job = await queue.enqueue({
      chatId: 200,
      description: "Создай сервис задач",
      selectedModel: { id: "quality", label: "Quality" }
    });

    await expect(queue.cancel(job.id, 200)).resolves.toMatchObject({
      id: job.id,
      status: "cancelled"
    });
    const retry = await queue.retry(job.id, 200);

    expect(retry).toMatchObject({
      status: "pending",
      attempt: 2,
      rootJobId: job.id,
      retryOfJobId: job.id
    });
  });
});
