import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

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


import {
  parseMoneyToMinorUnits,
  formatMinorUnits,
  calculateFeeMinorUnits
} from "./money.js";

test("money parsing preserves exact two-decimal amounts", () => {
  assert.equal(parseMoneyToMinorUnits("50"), 5000);
  assert.equal(parseMoneyToMinorUnits("50.05"), 5005);
  assert.equal(parseMoneyToMinorUnits(12.3), 1230);
  assert.equal(formatMinorUnits(5005), "50.05");
});

test("money parsing rejects invalid precision and unsafe values", () => {
  for (const value of ["", "-1", "1.234", "1e3", "abc", null, true, "90071992547409.92"]) {
    assert.equal(parseMoneyToMinorUnits(value), null);
  }
});

test("platform fee and provider amount reconcile exactly", () => {
  const gross = parseMoneyToMinorUnits("123.45");
  const fee = calculateFeeMinorUnits(gross, 10);
  assert.equal(formatMinorUnits(fee), "12.35");
  assert.equal(formatMinorUnits(gross - fee), "111.10");
  assert.equal(fee + (gross - fee), gross);
});

test("platform fee validates configured percentage", () => {
  assert.throws(() => calculateFeeMinorUnits(10000, -1));
  assert.throws(() => calculateFeeMinorUnits(10000, 100.01));
});

test("database startup migration is transactional and guards duplicate receipts", () => {
  const start = serverSource.indexOf("async function initDatabase()");
  const end = serverSource.indexOf("\nfunction auth(", start);
  const migration = serverSource.slice(start, end);
  assert.match(migration, /await client\.query\("BEGIN"\)/);
  assert.match(migration, /await client\.query\("COMMIT"\)/);
  assert.match(migration, /await client\.query\("ROLLBACK"\)/);
  assert.match(migration, /HAVING COUNT\(\*\) > 1/);
  assert.match(migration, /client\.release\(\)/);
});

test("task and M-PESA amounts use exact minor-unit arithmetic", () => {
  assert.match(serverSource, /parseMoneyToMinorUnits\(reward\)/);
  assert.match(serverSource, /calculateFeeMinorUnits\(paymentMinorUnits, feePct\)/);
  assert.match(serverSource, /!Number\.isSafeInteger\(paymentAmount\)/);
});


test("server.js and money.js pass Node syntax validation", () => {
  for (const file of ["server.js", "money.js", "mpesa.js"]) {
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8"
    });
    assert.equal(result.status, 0, `${file} syntax error: ${result.stderr}`);
  }
});

test("fee rounding remains precise for large valid amounts", () => {
  const gross = 99999999999999;
  const fee = calculateFeeMinorUnits(gross, 10);
  assert.equal(fee, 10000000000000);
  assert.equal(fee + (gross - fee), gross);
});
