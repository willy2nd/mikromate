export function parseWorkerCapacity(value = 1) {
  if (typeof value === "boolean" || value === null || value === "") return null;
  const capacity = Number(value);
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000) return null;
  return capacity;
}

export function getRemainingWorkerSlots(capacity, acceptedCount = 0) {
  const total = Number(capacity);
  const accepted = Number(acceptedCount);
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isFinite(accepted)) return 0;
  return Math.max(0, total - Math.max(0, Math.floor(accepted)));
}
