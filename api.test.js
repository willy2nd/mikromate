import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseWorkerCapacity, getRemainingWorkerSlots } from "./worker-capacity.js";

const source = readFileSync(new URL("./server.js", import.meta.url), "utf8");

test("poster applications endpoint is authenticated and its query scopes results to the poster", () => {
  const helperStart = source.indexOf("async function loadPosterApplications");
  const routeStart = source.indexOf('app.get("/api/poster/applications", auth');
  const routeEnd = source.indexOf('app.get("/api/tasks/:id/applications", auth', routeStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  const helper = source.slice(helperStart, routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(helper, /WHERE t\.owner_id=\$1/);
  assert.match(helper, /req\.user\.id/);
  assert.match(helper, /applications: result\.rows/);
  assert.match(route, /auth/);
});

test("application submission serializes capacity checks with decisions", () => {
  const start = source.indexOf('app.post("/api/tasks/:id/applications", auth');
  const end = source.indexOf('app.get("/api/my-applications"', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const route = source.slice(start, end);
  assert.match(route, /BEGIN/);
  assert.match(route, /FOR UPDATE/);
  assert.match(route, /worker_capacity/);
  assert.match(route, /ON CONFLICT\(task_id, applicant_id\) DO NOTHING/);
  assert.match(route, /COMMIT/);
  assert.match(route, /ROLLBACK/);
  assert.match(route, /client\.release\(\)/);
});

test("accept and reject decisions lock the task and enforce ownership and capacity", () => {
  const start = source.indexOf("async function decideTaskApplication");
  const end = source.indexOf('app.post("/api/applications/:id/accept", auth', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = source.slice(start, end);
  assert.match(handler, /FOR UPDATE/);
  assert.match(handler, /Only the task poster can decide applications/);
  assert.match(handler, /application\.status !== "PENDING"/);
  assert.match(handler, /getRemainingWorkerSlots/);
  assert.match(handler, /SET status='FILLED'/);
  assert.match(handler, /COMMIT/);
  assert.match(handler, /ROLLBACK/);
});

test("task creation persists validated worker capacity with default one", () => {
  const start = source.indexOf('app.post("/api/tasks", auth');
  const end = source.indexOf('app.post("/api/tasks/:id/accept"', start);
  const route = source.slice(start, end);
  assert.match(route, /worker_capacity/);
  assert.match(route, /workerCapacity === null/);
  assert.match(route, /workerCapacity/);
});

test("worker capacity validation defaults to one and rejects invalid values", () => {
  assert.equal(parseWorkerCapacity(), 1);
  assert.equal(parseWorkerCapacity("4"), 4);
  for (const value of [0, -1, 1.5, "abc", "", null, true, 1001]) {
    assert.equal(parseWorkerCapacity(value), null);
  }
});

test("remaining positions are clamped at zero", () => {
  assert.equal(getRemainingWorkerSlots(4, 0), 4);
  assert.equal(getRemainingWorkerSlots(4, 3), 1);
  assert.equal(getRemainingWorkerSlots(4, 4), 0);
  assert.equal(getRemainingWorkerSlots(4, 8), 0);
});
