import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serverSource = readFileSync(new URL("./server.js", import.meta.url), "utf8");

test("application submission serializes capacity checks with task decisions", () => {
  const routeStart = serverSource.indexOf('app.post("/api/tasks/:id/applications"');
  const routeEnd = serverSource.indexOf('app.get("/api/my-applications"', routeStart);
  assert.notEqual(routeStart, -1, "application submission route must exist");
  assert.notEqual(routeEnd, -1, "application route must end before my-applications route");

  const route = serverSource.slice(routeStart, routeEnd);
  assert.match(route, /await client\.query\("BEGIN"\)/);
  assert.match(route, /FROM tasks WHERE id=\$1 FOR UPDATE/);
  assert.match(route, /ON CONFLICT\(task_id, applicant_id\) DO NOTHING/);
  assert.match(route, /await client\.query\("COMMIT"\)/);
  assert.match(route, /await client\.query\("ROLLBACK"\)/);
  assert.match(route, /client\.release\(\)/);
});

test("application decisions lock the task and reject repeat decisions", () => {
  const decisionStart = serverSource.indexOf("async function decideTaskApplication");
  const decisionEnd = serverSource.indexOf('app.post("/api/applications/:id/accept"', decisionStart);
  assert.notEqual(decisionStart, -1, "application decision handler must exist");
  assert.notEqual(decisionEnd, -1, "application decision routes must follow the handler");

  const handler = serverSource.slice(decisionStart, decisionEnd);
  assert.match(handler, /FOR UPDATE/);
  assert.match(handler, /Only the task poster can decide applications/);
  assert.match(handler, /application\.status !== "PENDING"/);
  assert.match(handler, /getRemainingWorkerSlots\(task\.worker_capacity, acceptedWorkers\)/);
  assert.match(handler, /SET status='FILLED'/);
});

import {
  parseWorkerCapacity,
  getRemainingWorkerSlots,
  hasAvailableWorkerCapacity
} from "./worker-capacity.js";

test("worker capacity defaults to one", () => {
  assert.equal(parseWorkerCapacity(), 1);
});

test("worker capacity accepts valid positive whole numbers", () => {
  assert.equal(parseWorkerCapacity(1), 1);
  assert.equal(parseWorkerCapacity("5"), 5);
  assert.equal(parseWorkerCapacity(1000), 1000);
});

test("worker capacity rejects invalid or unsafe values", () => {
  for (const value of [0, -1, 1.5, "abc", "", null, true, 1001]) {
    assert.equal(parseWorkerCapacity(value), null);
  }
});

test("remaining positions never fall below zero", () => {
  assert.equal(getRemainingWorkerSlots(5, 0), 5);
  assert.equal(getRemainingWorkerSlots(5, 2), 3);
  assert.equal(getRemainingWorkerSlots(5, 5), 0);
  assert.equal(getRemainingWorkerSlots(5, 8), 0);
});

test("capacity availability is based on accepted workers", () => {
  assert.equal(hasAvailableWorkerCapacity(3, 2), true);
  assert.equal(hasAvailableWorkerCapacity(3, 3), false);
});
