import { saveConversation } from "./database.js";
import { appendCompletionMark } from "./utils.js";
import { buildPermissionUsageEmbed } from "./permissionEmbed.js";

function toStatusPayload(text, permissionLines) {
  const permissionEmbed = buildPermissionUsageEmbed(permissionLines);
  if (!permissionEmbed) return text;
  return { content: text, embeds: [permissionEmbed] };
}

/**
 * Shared status message updater with consistent fallback behavior.
 *
 * @param {import("discord.js").Message} message
 * @param {import("discord.js").Message} statusMessage
 * @param {string} text
 * @param {{
 *   permissionLines?: string[],
 *   appendMark?: boolean,
 *   saveToConversation?: boolean,
 *   saveCompletedText?: boolean,
 *   fallbackToChannel?: boolean
 * }} options
 */
export async function updateStatusMessage(message, statusMessage, text, options = {}) {
  const {
    permissionLines = [],
    appendMark = true,
    saveToConversation = true,
    saveCompletedText = false,
    fallbackToChannel = false,
  } = options;

  const rawText = String(text ?? "");
  const completedText = appendMark ? appendCompletionMark(rawText) : rawText;
  const payload = toStatusPayload(completedText, permissionLines);

  try {
    await statusMessage.edit(payload);
  } catch {
    try {
      await message.reply(payload);
    } catch (replyError) {
      if (!fallbackToChannel || !message.channel?.isTextBased?.()) {
        throw replyError;
      }
      await message.channel.send(payload);
    }
  }

  if (saveToConversation) {
    saveConversation(message, "assistant", saveCompletedText ? completedText : rawText);
  }

  return completedText;
}
