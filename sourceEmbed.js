import { EmbedBuilder } from "discord.js";

function normalizeSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources
    .map((source) => {
      const uri = String(source?.uri || "").trim();
      if (!uri) return null;
      const title = String(source?.title || "").trim();
      return { title, uri };
    })
    .filter(Boolean);
}

function escapeMarkdownLabel(text) {
  return String(text || "").replace(/[[\]()`]/g, "\\$&");
}

export function buildWebSearchSourcesEmbed(sources = []) {
  const normalized = normalizeSources(sources).slice(0, 5);
  if (normalized.length === 0) return null;

  const lines = normalized.map((source, index) => {
    let label = source.title;
    if (!label) {
      try {
        label = new URL(source.uri).host;
      } catch {
        label = source.uri;
      }
    }
    const safeLabel = escapeMarkdownLabel(label);
    const linked = safeLabel ? `[${safeLabel}](${source.uri})` : source.uri;
    return `${index + 1}. ${linked}`;
  });

  return new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("검색 출처")
    .setDescription(lines.map((line) => `- ${line}`).join("\n"));
}
