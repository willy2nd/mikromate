const MAX_MINOR_UNITS = 99_999_999_999_999;

export function parseMoneyToMinorUnits(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor) || minor < 0 || minor > MAX_MINOR_UNITS) {
    return null;
  }
  return minor;
}

export function formatMinorUnits(minorUnits) {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0 ||
      minorUnits > MAX_MINOR_UNITS) {
    throw new TypeError("Invalid monetary amount");
  }
  return `${Math.floor(minorUnits / 100)}.${String(minorUnits % 100).padStart(2, "0")}`;
}

export function calculateFeeMinorUnits(amountMinorUnits, percent) {
  if (!Number.isSafeInteger(amountMinorUnits) || amountMinorUnits < 0) {
    throw new TypeError("Invalid monetary amount");
  }
  const percentText = String(percent);
  if (!/^\d+(?:\.\d{1,2})?$/.test(percentText)) {
    throw new TypeError("Invalid platform fee percentage");
  }
  const [whole, fraction = ""] = percentText.split(".");
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(basisPoints) || basisPoints > 10000) {
    throw new RangeError("Platform fee must be between 0 and 100 percent");
  }
  return Math.round(amountMinorUnits * basisPoints / 10000);
}
