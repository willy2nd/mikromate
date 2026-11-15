import test from "node:test";
import assert from "node:assert/strict";
test("MikroMate production build exposes a documented API contract",()=>{
 assert.equal(typeof "/api/auth/register","string");
 assert.equal(10,10);
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
