import { PermissionFlagsBits } from "discord.js";

function normalizePermissionToken(token) {
  return String(token || "")
    .trim()
    .replace(/^PermissionFlagsBits\./i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
}

const permissionLookup = new Map();
for (const permissionName of Object.keys(PermissionFlagsBits)) {
  const normalized = normalizePermissionToken(permissionName);
  if (normalized) {
    permissionLookup.set(normalized, permissionName);
  }
}

export function resolvePermissionNames(input) {
  const rawTokens = Array.isArray(input)
    ? input.flatMap((value) => String(value || "").split(/[\s,]+/))
    : String(input || "").split(/[\s,]+/);

  const validPermissions = [];
  const invalidTokens = [];

  for (const rawToken of rawTokens) {
    const token = String(rawToken || "").trim();
    if (!token) continue;

    const normalized = normalizePermissionToken(token);
    const matched = permissionLookup.get(normalized);
    if (!matched) {
      invalidTokens.push(token);
      continue;
    }
    if (!validPermissions.includes(matched)) {
      validPermissions.push(matched);
    }
  }

  return { validPermissions, invalidTokens };
}

export function listPermissionExamples(limit = 10) {
  return Object.keys(PermissionFlagsBits).slice(0, limit);
}
