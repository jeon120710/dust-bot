import { EmbedBuilder } from "discord.js";

export function buildPermissionUsageEmbed(lines = []) {
  const normalized = Array.isArray(lines)
    ? lines.map((line) => String(line || "").trim()).filter(Boolean)
    : [];
  if (normalized.length === 0) return null;

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("권한 사용")
    .setDescription(normalized.map((line) => `- ${line}`).join("\n"));
}
