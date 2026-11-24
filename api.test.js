import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { app, initDatabase, pool } from "./server.js";

const { Pool } = pg;
let server;
let baseUrl;
let cleanupPool;
let sequence = 0;

async function request(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

async function register(label) {
  sequence += 1;
  const result = await request("/api/auth/register", {
    method: "POST",
    body: {
      name: `Integration ${label}`,
      email: `applications-${Date.now()}-${sequence}@example.test`,
      password: "Test-password-123!",
      country_code: "KE"
    }
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return { token: result.data.token, user: result.data.user };
}

async function createTask(posterToken, capacity = 1) {
  const result = await request("/api/tasks", {
    method: "POST",
    token: posterToken,
    body: {
      title: "Integration test task",
      description: "Disposable automated test task",
      category: "Testing",
      reward: 100,
      currency: "KES",
      worker_capacity: capacity
    }
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}

async function apply(taskId, applicantToken) {
  return request(`/api/tasks/${taskId}/applications`, {
    method: "POST",
    token: applicantToken,
    body: { message: "I would like to do this task." }
  });
}

before(async () => {
  if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
    throw new Error("Integration tests require disposable DATABASE_URL and JWT_SECRET values.");
  }
  cleanupPool = new Pool({ connectionString: process.env.DATABASE_URL });
  await initDatabase();
  await cleanupPool.query(
    "TRUNCATE TABLE task_applications, tasks, users RESTART IDENTITY CASCADE"
  );
  await new Promise((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not bind test server"));
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
    server.on("error", reject);
  });
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (cleanupPool) await cleanupPool.end();
  await pool.end();
});

test("poster applications API requires authentication", async () => {
  const result = await request("/api/poster/applications");
  assert.equal(result.status, 401);
});

test("poster sees only applications for tasks they own", async () => {
  const poster = await register("poster");
  const otherPoster = await register("other-poster");
  const worker = await register("worker");
  const ownTask = await createTask(poster.token);
  const otherTask = await createTask(otherPoster.token);

  assert.equal((await apply(ownTask.id, worker.token)).status, 201);
  assert.equal((await apply(otherTask.id, worker.token)).status, 201);

  const received = await request("/api/poster/applications", { token: poster.token });
  assert.equal(received.status, 200);
  assert.equal(received.data.applications.length, 1);
  assert.equal(Number(received.data.applications[0].task_id), Number(ownTask.id));
  assert.equal(received.data.applications[0].applicant_name, "Integration worker");
});

test("applicant cannot apply twice or apply to own task", async () => {
  const poster = await register("duplicate-poster");
  const worker = await register("duplicate-worker");
  const task = await createTask(poster.token);

  assert.equal((await apply(task.id, poster.token)).status, 403);
  assert.equal((await apply(task.id, worker.token)).status, 201);
  const duplicate = await apply(task.id, worker.token);
  assert.equal(duplicate.status, 409);
});

test("only the task owner can accept or reject an application", async () => {
  const poster = await register("owner");
  const stranger = await register("stranger");
  const worker = await register("applicant");
  const task = await createTask(poster.token);
  const submitted = await apply(task.id, worker.token);
  const applicationId = submitted.data.application.id;

  const forbidden = await request(`/api/applications/${applicationId}/accept`, {
    method: "POST", token: stranger.token, body: {}
  });
  assert.equal(forbidden.status, 403);

  const accepted = await request(`/api/applications/${applicationId}/accept`, {
    method: "POST", token: poster.token, body: {}
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.application.status, "ACCEPTED");

  const secondDecision = await request(`/api/applications/${applicationId}/reject`, {
    method: "POST", token: poster.token, body: {}
  });
  assert.equal(secondDecision.status, 409);
});

test("concurrent accept decisions never exceed task worker capacity", async () => {
  const poster = await register("capacity-poster");
  const workerOne = await register("capacity-worker-one");
  const workerTwo = await register("capacity-worker-two");
  const task = await createTask(poster.token, 1);
  const first = await apply(task.id, workerOne.token);
  const second = await apply(task.id, workerTwo.token);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const decisions = await Promise.all([
    request(`/api/applications/${first.data.application.id}/accept`, {
      method: "POST", token: poster.token, body: {}
    }),
    request(`/api/applications/${second.data.application.id}/accept`, {
      method: "POST", token: poster.token, body: {}
    })
  ]);

  assert.equal(decisions.filter(x => x.status === 200).length, 1);
  assert.equal(decisions.filter(x => x.status === 409).length, 1);
  const count = await cleanupPool.query(
    "SELECT COUNT(*)::int AS accepted FROM task_applications WHERE task_id=$1 AND status='ACCEPTED'",
    [task.id]
  );
  assert.equal(count.rows[0].accepted, 1);
});

test("task creation validates capacity and defaults to one worker", async () => {
  const poster = await register("capacity-validation");
  const defaultTask = await request("/api/tasks", {
    method: "POST", token: poster.token,
    body: { title: "Default capacity", description: "Test", category: "Testing", reward: 100 }
  });
  assert.equal(defaultTask.status, 201);
  assert.equal(defaultTask.data.worker_capacity, 1);

  const invalid = await request("/api/tasks", {
    method: "POST", token: poster.token,
    body: { title: "Invalid capacity", description: "Test", category: "Testing", reward: 100, worker_capacity: 1.5 }
  });
  assert.equal(invalid.status, 400);
});
