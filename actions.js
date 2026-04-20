import { ChannelType, PermissionFlagsBits } from "discord.js";
import { normalizeSnowflake, appendCompletionMark, safeParseJsonObject } from "./utils.js";
import { resolveTargetMember, isExplicitTargetInInput } from "./members.js";
import { resolveTargetRole } from "./roles.js";
import { saveConversation } from "./database.js";
import { logActionAudit, logError } from "./logger.js";
import { ABSOLUTE_POWER_USER_ID } from "./config.js";
import { buildPermissionUsageEmbed } from "./permissionEmbed.js";
import { callModel } from "./ai.js";
import { resolvePermissionNames, listPermissionExamples } from "./permissions.js";

function hasPerm(member, permission, authorId) {
  if (authorId && authorId === ABSOLUTE_POWER_USER_ID) return true;
  return member?.permissions?.has(permission) === true;
}

function hasChannelPerm(channel, botMember, permission) {
  return channel?.permissionsFor(botMember)?.has(permission) === true;
}

function isCurrentChannelToken(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "" || ["current_channel", "current-channel", "this_channel", "here", "현재채널", "현재 채널"].includes(raw);
}

function resolveChannelIdInput(value, fallbackChannelId) {
  if (isCurrentChannelToken(value)) return fallbackChannelId;
  return normalizeSnowflake(value);
}

function getActionErrorMessage(error) {
  const code = Number(error?.code);
  if (code === 50013 || code === 50001) return "봇 권한이 부족하여 실행할 수 없습니다.";
  if (code === 10003) return "대상 채널을 찾을 수 없습니다.";
  if (code === 10008) return "대상 메시지를 찾을 수 없습니다.";
  if (code === 10007) return "대상 사용자를 찾을 수 없습니다.";
  if (code === 50035) return "액션 파라미터 형식이 잘못되었습니다.";
  return "액션 실행 중 오류가 발생했습니다.";
}

function normalizeChannelName(value) {
  const raw = String(value || "").trim().toLowerCase();
  let out = "";
  for (const ch of raw) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "-" || ch === "_") continue;
    out += ch;
  }
  return out;
}

function isVoiceChannelType(channel) {
  return channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice;
}

function isSelfTarget(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "" || raw === "self" || raw === "me" || raw === "myself" || raw === "나" || raw === "저" || raw === "나자신";
}

function escapePromptText(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"");
}

async function extractDeleteChannelQueryByAi(inputText) {
  const text = String(inputText || "").trim();
  if (!text) return "";

  const prompt = `
당신은 디스코드 채널명 추출기입니다.
아래 문장에서 "삭제 대상 채널명"만 추출하세요.
명확하지 않으면 빈 문자열을 반환하세요.

출력은 JSON 객체 1개만:
{"channelName":"채널명 또는 빈 문자열","reason":"짧은 근거"}

message: "${escapePromptText(text)}"
`;

  try {
    const resultText = await callModel(prompt);
    const parsed = safeParseJsonObject(resultText);
    return String(parsed?.channelName || "").trim();
  } catch {
    return "";
  }
}

async function resolveTargetChannel(guild, channelIdInput, channelNameInput, inputText, fallbackChannelId) {
  const channelId = resolveChannelIdInput(channelIdInput, fallbackChannelId);
  if (channelId) {
    const byId = await guild.channels.fetch(channelId).catch(() => null);
    if (byId) return { ok: true, channel: byId };
  }

  const explicitName = String(channelNameInput || "").trim();
  const aiExtractedName = explicitName ? "" : await extractDeleteChannelQueryByAi(inputText);
  const rawQuery = explicitName || aiExtractedName;
  if (!rawQuery) return { ok: false, reason: "missing_target" };

  const query = normalizeChannelName(rawQuery);
  const all = await guild.channels.fetch();
  const matches = Array.from(all.values()).filter((ch) => normalizeChannelName(ch?.name) === query);

  if (matches.length === 1) return { ok: true, channel: matches[0] };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", query: rawQuery };
  return { ok: false, reason: "not_found", query: rawQuery };
}

async function resolveTargetVoiceChannelByAi(guild, channelIdInput, channelNameInput, inputText) {
  const channelId = resolveChannelIdInput(channelIdInput, null);
  if (channelId) {
    const byId = await guild.channels.fetch(channelId).catch(() => null);
    if (byId && isVoiceChannelType(byId)) return { ok: true, channel: byId };
    return { ok: false, reason: "target_channel_not_voice" };
  }

  const all = await guild.channels.fetch();
  const voiceChannels = Array.from(all.values()).filter((channel) => isVoiceChannelType(channel));
  if (voiceChannels.length === 0) {
    return { ok: false, reason: "no_voice_channels" };
  }

  const query = String(channelNameInput || "").trim();
  const rawMessage = String(inputText || "").trim();
  const candidates = voiceChannels.map((channel) => ({
    id: channel.id,
    name: String(channel.name || ""),
    userLimit: Number(channel.userLimit || 0),
    memberCount: Number(channel.members?.size || 0),
  }));

  const prompt = `
당신은 디스코드 음성채널 선택기입니다.
아래 후보 중 사용자 요청과 가장 가까운 채널 하나를 고르세요.
의도와 맞는 채널이 없으면 selectedChannelId를 빈 문자열로 두세요.

출력은 JSON 객체 1개만:
{"selectedChannelId":"채널ID 또는 빈 문자열","confidence":"high|medium|low","reason":"짧은 근거"}

선택 규칙:
- 이름이 정확히 같지 않아도 발음/표기/유사 의미가 가장 가까우면 선택
- "2번방", "투", "to", "two" 같은 표현은 유사 숫자 이름도 고려
- 확신이 낮으면 confidence를 low로 두고 selectedChannelId는 빈 문자열

query: "${escapePromptText(query)}"
message: "${escapePromptText(rawMessage)}"
voiceChannels: ${JSON.stringify(candidates)}
`;

  try {
    const resultText = await callModel(prompt);
    const parsed = safeParseJsonObject(resultText);
    let selectedChannelId = normalizeSnowflake(
      parsed?.selectedChannelId || parsed?.channelId || parsed?.bestChannelId || "",
    );
    const selectedChannelName = String(
      parsed?.selectedChannelName || parsed?.channelName || parsed?.name || "",
    ).trim();

    if (!selectedChannelId && selectedChannelName) {
      const normalizedName = normalizeChannelName(selectedChannelName);
      const byName = voiceChannels.find((channel) => normalizeChannelName(channel.name) === normalizedName);
      if (byName) selectedChannelId = byName.id;
    }

    if (!selectedChannelId) {
      const forcedPrompt = `
당신은 디스코드 음성채널 선택기입니다.
아래 후보 중에서 요청과 가장 가까운 채널 ID를 반드시 1개 선택하세요.
반드시 목록 안의 id만 선택하세요.

출력은 JSON 객체 1개만:
{"selectedChannelId":"반드시 후보 중 하나의 채널ID","reason":"짧은 근거"}

query: "${escapePromptText(query)}"
message: "${escapePromptText(rawMessage)}"
voiceChannels: ${JSON.stringify(candidates)}
`;
      const forcedText = await callModel(forcedPrompt);
      const forcedParsed = safeParseJsonObject(forcedText);
      selectedChannelId = normalizeSnowflake(
        forcedParsed?.selectedChannelId || forcedParsed?.channelId || forcedParsed?.bestChannelId || "",
      );
    }

    if (!selectedChannelId) {
      return { ok: false, reason: "not_found", query: query || rawMessage };
    }

    const matched = voiceChannels.find((channel) => channel.id === selectedChannelId);
    if (!matched) {
      return { ok: false, reason: "not_found", query: query || rawMessage };
    }
    return { ok: true, channel: matched };
  } catch {
    return { ok: false, reason: "classify_error", query: query || rawMessage };
  }
}

async function updateStatus(message, statusMessage, text, options = {}) {
  const payload = appendCompletionMark(text);
  const permissionEmbed = buildPermissionUsageEmbed(options.permissionLines);
  const finalPayload = permissionEmbed ? { content: payload, embeds: [permissionEmbed] } : payload;

  try {
    await statusMessage.edit(finalPayload);
  } catch (err) {
    try {
      await message.reply(finalPayload);
    } catch {
      if (message.channel?.isTextBased?.()) {
        await message.channel.send(finalPayload);
      }
    }
  }
  saveConversation(message, "assistant", text);
}

export async function executeAction(message, actionObj, statusMessage, inputText) {
  const action = actionObj.action;
  const guild = message.guild;
  const auditBase = {
    action,
    guildId: message.guild?.id || null,
    userId: message.author?.id || null,
    commandText: inputText,
  };
  const audit = (meta) => logActionAudit({ ...auditBase, ...meta });
  try {
  audit({ phase: "attempt" });

  if (action === "reply") {
    const text = typeof actionObj.message === "string" ? actionObj.message : "올바른 응답을 받을 수 없습니다.";
    audit({ phase: "rejected", reason: text });
    await updateStatus(message, statusMessage, text);
    return;
  }

  if (!guild) {
    audit({ phase: "rejected", reason: "guild_not_found" });
    await updateStatus(message, statusMessage, "서버(길드) 정보를 찾을 수 없습니다.");
    return;
  }

  const botMember = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    audit({ phase: "rejected", reason: "bot_member_not_found" });
    await updateStatus(message, statusMessage, "봇 계정 정보를 가져오지 못했습니다.");
    return;
  }

  // message.member 확인 (DM이 아닌 경우)
  if (!message.member && message.author) {
    message.member = await guild.members.fetch(message.author.id).catch(() => null);
    if (!message.member) {
      audit({ phase: "rejected", reason: "member_not_found" });
      await updateStatus(message, statusMessage, "사용자 정보를 가져오지 못했습니다.");
      return;
    }
  }

  if (action === "send") {
    const channelId = resolveChannelIdInput(actionObj.channelId, message.channel.id);
    const text = typeof actionObj.message === "string" ? actionObj.message : null;
    if (!text) {
      audit({ phase: "rejected", reason: "missing_message" });
      await updateStatus(message, statusMessage, "보낼 메시지가 없습니다.");
      return;
    }
    if (!channelId) {
      audit({ phase: "rejected", reason: "invalid_channel_id" });
      await updateStatus(message, statusMessage, "필수 파라미터 channelId(채널 ID)가 필요합니다.");
      return;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      audit({ phase: "rejected", reason: "channel_not_found" });
      await updateStatus(message, statusMessage, "텍스트 채널을 찾을 수 없습니다.");
      return;
    }

    if (!hasPerm(message.member, PermissionFlagsBits.SendMessages, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "SendMessages", reason: "missing_permission" });
      await updateStatus(message, statusMessage, "메시지를 보낼 권한이 없습니다.");
      return;
    }
    if (!hasChannelPerm(channel, botMember, PermissionFlagsBits.SendMessages)) {
      audit({ phase: "rejected", requiredPermission: "SendMessages(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇이 해당 채널에 메시지를 보낼 권한이 없습니다.");
      return;
    }

    try {
      await channel.send(text);
    } catch (err) {
      audit({ phase: "failed", reason: "send_failed", error: err.code });
      await updateStatus(message, statusMessage, "메시지 전송 중 오류가 발생했습니다.");
      logError("action.send", err);
      return;
    }

    audit({ phase: "success", requiredPermission: "SendMessages" });
    await updateStatus(message, statusMessage, "메시지를 성공적으로 보냈습니다.", {
      permissionLines: ["요청자: SendMessages", "봇: SendMessages"],
    });
    return;
  }

  if (action === "send_dm") {
    if (message.author?.id !== ABSOLUTE_POWER_USER_ID) {
      audit({ phase: "rejected", requiredPermission: "absolute_power_user", reason: "missing_permission" });
      await updateStatus(message, statusMessage, "DM 전송 권한이 없습니다.");
      return;
    }

    const text = typeof actionObj.message === "string" ? actionObj.message : null;
    const targetInput = actionObj.userId || actionObj.user || actionObj.username || actionObj.target;
    if (!text) {
      audit({ phase: "rejected", reason: "missing_message" });
      await updateStatus(message, statusMessage, "보낼 메시지가 없습니다.");
      return;
    }
    if (!targetInput) {
      audit({ phase: "rejected", reason: "missing_target" });
      await updateStatus(message, statusMessage, "필수 파라미터 userId(사용자 ID)가 필요합니다.");
      return;
    }

    let user = null;
    const targetId = normalizeSnowflake(targetInput);
    if (targetId) {
      user = await message.client.users.fetch(targetId).catch(() => null);
    } else {
      const resolved = await resolveTargetMember(guild, targetInput, { strict: true, safeFuzzy: true });
      if (!resolved.ok) {
        audit({ phase: "rejected", reason: "user_not_found", target: String(targetInput || "") });
        await updateStatus(message, statusMessage, resolved.message);
        return;
      }
      user = resolved.member.user;
    }

    if (!user) {
      audit({ phase: "rejected", reason: "user_not_found", target: String(targetInput || "") });
      await updateStatus(message, statusMessage, "대상 사용자를 찾을 수 없습니다.");
      return;
    }

    try {
      await user.send(text);
    } catch (error) {
      const code = Number(error?.code);
      const reason = code === 50007 ? "dm_blocked" : "dm_failed";
      audit({
        phase: "rejected",
        reason,
        targetUserId: user?.id || null,
      });
      logError("action.send_dm", error, {
        targetUserId: user?.id || null,
      });
      await updateStatus(
        message,
        statusMessage,
        code === 50007
          ? "DM을 보낼 수 없습니다. 상대방이 DM을 차단했거나 서버 DM을 허용하지 않을 수 있습니다."
          : "DM 전송 중 오류가 발생했습니다.",
      );
      return;
    }

    audit({ phase: "success", requiredPermission: "absolute_power_user", targetUserId: user?.id || null });
    await updateStatus(message, statusMessage, "DM을 성공적으로 보냈습니다.", {
      permissionLines: ["최고 권력자: DM 전송"],
    });
    return;
  }

  if (action === "delete_message") {
    if (!hasPerm(message.member, PermissionFlagsBits.ManageMessages, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "ManageMessages", reason: "missing_permission" });
      await updateStatus(message, statusMessage, "메시지 삭제 권한이 없습니다.");
      return;
    }

    const targetMessageId = normalizeSnowflake(actionObj.messageId);
    const targetChannelId = resolveChannelIdInput(actionObj.channelId, message.channel.id);
    if (!targetMessageId) {
      audit({ phase: "rejected", reason: "invalid_message_id" });
      await updateStatus(message, statusMessage, "필수 파라미터 messageId(메시지 ID)가 필요합니다.");
      return;
    }
    if (!targetChannelId) {
      audit({ phase: "rejected", reason: "invalid_channel_id" });
      await updateStatus(message, statusMessage, "필수 파라미터 channelId(채널 ID)가 필요합니다.");
      return;
    }

    const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
    if (!channel?.isTextBased()) {
      audit({ phase: "rejected", reason: "channel_not_found" });
      await updateStatus(message, statusMessage, "텍스트 채널을 찾을 수 없습니다.");
      return;
    }
    if (!hasChannelPerm(channel, botMember, PermissionFlagsBits.ManageMessages)) {
      audit({ phase: "rejected", requiredPermission: "ManageMessages(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇이 해당 채널에서 메시지를 삭제할 권한이 없습니다.");
      return;
    }

    const targetMessage = await channel.messages.fetch(targetMessageId).catch(() => null);
    if (!targetMessage) {
      audit({ phase: "rejected", reason: "message_not_found" });
      await updateStatus(message, statusMessage, "삭제할 메시지를 찾을 수 없습니다.");
      return;
    }
    
    try {
      await targetMessage.delete();
    } catch (err) {
      audit({ phase: "failed", reason: "delete_failed", error: err.code });
      await updateStatus(message, statusMessage, "메시지 삭제 중 오류가 발생했습니다.");
      logError("action.delete_message", err);
      return;
    }
    
    audit({ phase: "success", requiredPermission: "ManageMessages" });
    await updateStatus(message, statusMessage, "메시지를 성공적으로 삭제했습니다.", {
      permissionLines: ["요청자: ManageMessages", "봇: ManageMessages"],
    });
    return;
  }

  if (action === "delete_messages") {
    if (!hasPerm(message.member, PermissionFlagsBits.ManageMessages, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "ManageMessages", reason: "missing_permission" });
      await updateStatus(message, statusMessage, "메시지 삭제 권한이 없습니다.");
      return;
    }

    const targetChannelId = resolveChannelIdInput(actionObj.channelId, message.channel.id);
    const requestedCount = Number(actionObj.count ?? actionObj.amount ?? actionObj.limit ?? 0);

    if (!targetChannelId) {
      audit({ phase: "rejected", reason: "invalid_channel_id" });
      await updateStatus(message, statusMessage, "필수 파라미터 channelId(채널 ID)가 필요합니다.");
      return;
    }
    if (!Number.isInteger(requestedCount) || requestedCount <= 0 || requestedCount > 100) {
      audit({ phase: "rejected", reason: "invalid_delete_count" });
      await updateStatus(message, statusMessage, "delete_messages 파라미터(count)는 1~100 사이 정수여야 합니다.");
      return;
    }

    const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
    if (!channel?.isTextBased() || typeof channel.bulkDelete !== "function") {
      audit({ phase: "rejected", reason: "channel_not_bulk_deletable" });
      await updateStatus(message, statusMessage, "해당 채널에서는 대량 메시지 삭제를 지원하지 않습니다.");
      return;
    }
    if (!hasChannelPerm(channel, botMember, PermissionFlagsBits.ManageMessages)) {
      audit({ phase: "rejected", requiredPermission: "ManageMessages(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇이 해당 채널에서 메시지를 삭제할 권한이 없습니다.");
      return;
    }
    if (!hasChannelPerm(channel, botMember, PermissionFlagsBits.ReadMessageHistory)) {
      audit({ phase: "rejected", requiredPermission: "ReadMessageHistory(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇이 해당 채널의 메시지 기록을 읽을 권한이 없습니다.");
      return;
    }
    if (typeof channel.messages?.fetch !== "function") {
      audit({ phase: "rejected", reason: "channel_not_message_fetchable" });
      await updateStatus(message, statusMessage, "해당 채널에서는 메시지 목록을 조회할 수 없습니다.");
      return;
    }

    const fetchLimit = Math.min(100, requestedCount + 20);
    const recentMessages = await channel.messages.fetch({ limit: fetchLimit });
    const targetMessages = recentMessages
      .filter((m) => m.id !== message.id && m.id !== statusMessage?.id && !m.pinned)
      .first(requestedCount);

    if (!targetMessages || targetMessages.length === 0) {
      audit({ phase: "rejected", reason: "no_bulk_delete_target" });
      await updateStatus(message, statusMessage, "삭제할 수 있는 최근 메시지를 찾지 못했습니다.");
      return;
    }

    const deleted = await channel.bulkDelete(targetMessages, true);
    const deletedCount = deleted?.size || 0;
    audit({
      phase: "success",
      requiredPermission: "ManageMessages",
      targetChannelId,
      targetCount: requestedCount,
      deletedCount,
    });

    if (deletedCount === 0) {
      await updateStatus(message, statusMessage, "삭제할 수 있는 최근 메시지를 찾지 못했습니다. (14일이 지난 메시지는 일괄 삭제 불가)");
      return;
    }
    await updateStatus(message, statusMessage, `최근 메시지 ${deletedCount}개를 삭제했습니다. (요청: ${requestedCount}개)`, {
      permissionLines: ["요청자: ManageMessages", "봇: ManageMessages", "봇: ReadMessageHistory"],
    });
    return;
  }

  if (action === "timeout") {
    await statusMessage.edit(`${message.author.displayName}님의 권한을 확인할게요`);
    if (!hasPerm(message.member, PermissionFlagsBits.ModerateMembers, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "ModerateMembers", reason: "missing_permission" });
      const prompt = `봇으로서 사용자에게 권한 부족을 정중하게 알려줘. 존댓말로.

요청한 행동: 타임아웃

권한: ModerateMembers 부족`;
      const response = await callModel(prompt, { channel: message.channel });
      await statusMessage.edit(response);
      return;
    }
    if (!botMember.permissions?.has(PermissionFlagsBits.ModerateMembers)) {
      audit({ phase: "rejected", requiredPermission: "ModerateMembers(bot)", reason: "bot_missing_permission" });
      const prompt = `봇으로서 사용자에게 봇 권한 부족을 정중하게 알려줘. 존댓말로.

요청한 행동: 타임아웃

봇 권한: ModerateMembers 부족`;
      const response = await callModel(prompt, { channel: message.channel });
      await statusMessage.edit(response);
      return;
    }

    const targetInput = actionObj.userId || actionObj.user || actionObj.username || actionObj.target;
    const minutes = Number(actionObj.minutes || 5);
    const reason = typeof actionObj.reason === "string" ? actionObj.reason : "AI moderation";

    if (Number.isNaN(minutes) || minutes <= 0) {
      audit({ phase: "rejected", reason: "invalid_minutes" });
      await updateStatus(message, statusMessage, "timeout 파라미터(minutes)가 올바르지 않습니다.");
      return;
    }

    const resolved = await resolveTargetMember(guild, targetInput, { safeFuzzy: false });
    if (!resolved.ok) {
      audit({ phase: "rejected", reason: "target_not_found" });
      await updateStatus(message, statusMessage, resolved.message);
      return;
    }

    const member = resolved.member;
    const userId = member.id;
    if (!isExplicitTargetInInput(inputText, member, targetInput)) {
      if (resolved.matchType === "partial" || resolved.matchType === "partial_comparable") {
        await statusMessage.edit(`대상자가 명령문에 명확히 지정되지 않았습니다. <@${userId}> (${member.displayName}) 이 맞나요?`);
        throw new Error("target_confirmation_required");
      } else {
        audit({ phase: "rejected", reason: "target_not_explicit" });
        await updateStatus(message, statusMessage, "대상자가 명령문에 명확히 지정되지 않았습니다. 안전상 실행이 불가능합니다. 명시적으로 사용자/ID를 사용해 주세요.");
        return;
      }
    }
    if (!member.moderatable) {
      audit({ phase: "rejected", reason: "target_not_moderatable" });
      await updateStatus(message, statusMessage, "대상 사용자는 역할 위계로 인해 타임아웃할 수 없습니다.");
      return;
    }
    await member.timeout(minutes * 60 * 1000, reason);
    audit({ phase: "success", requiredPermission: "ModerateMembers", targetUserId: userId });
    const prompt = `봇으로서 사용자에게 이 관리 행동 결과를 자연스럽게 알려줘. 존댓말로 정중하게.

행동: 타임아웃

대상: ${member.displayName} (${userId})

시간: ${minutes}분

이유: ${reason}

결과: 성공

권한 정보: 요청자 ModerateMembers, 봇 ModerateMembers`;
    const response = await callModel(prompt, { channel: message.channel });
    const permissionEmbed = buildPermissionUsageEmbed(["요청자: ModerateMembers", "봇: ModerateMembers"]);
    await statusMessage.edit(response, permissionEmbed ? { embeds: [permissionEmbed] } : {});
    return;
  }

  if (action === "kick") {
    await statusMessage.edit(`${message.author.displayName}님의 권한을 확인할게요`);
    if (!hasPerm(message.member, PermissionFlagsBits.KickMembers, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "KickMembers", reason: "missing_permission" });
      const prompt = `봇으로서 사용자에게 권한 부족을 정중하게 알려줘. 존댓말로.

요청한 행동: 강제 퇴장

권한: KickMembers 부족`;
      const response = await callModel(prompt, { channel: message.channel });
      await statusMessage.edit(response);
      return;
    }
    if (!botMember.permissions?.has(PermissionFlagsBits.KickMembers)) {
      audit({ phase: "rejected", requiredPermission: "KickMembers(bot)", reason: "bot_missing_permission" });
      const prompt = `봇으로서 사용자에게 봇 권한 부족을 정중하게 알려줘. 존댓말로.

요청한 행동: 강제 퇴장

봇 권한: KickMembers 부족`;
      const response = await callModel(prompt, { channel: message.channel });
      await statusMessage.edit(response);
      return;
    }

    const targetInput = actionObj.userId || actionObj.user || actionObj.username || actionObj.target;
    const reason = typeof actionObj.reason === "string" ? actionObj.reason : "AI moderation";

    const resolved = await resolveTargetMember(guild, targetInput, { safeFuzzy: false });
    if (!resolved.ok) {
      audit({ phase: "rejected", reason: "target_not_found" });
      await updateStatus(message, statusMessage, resolved.message);
      return;
    }

    const member = resolved.member;
    const userId = member.id;
    if (!isExplicitTargetInInput(inputText, member, targetInput)) {
      if (resolved.matchType === "partial" || resolved.matchType === "partial_comparable") {
        await statusMessage.edit(`대상자가 명령문에 명확히 지정되지 않았습니다. <@${userId}> (${member.displayName}) 이 맞나요?`);
        throw new Error("target_confirmation_required");
      } else {
        audit({ phase: "rejected", reason: "target_not_explicit" });
        await updateStatus(message, statusMessage, "대상자가 명령문에 명확히 지정되지 않았습니다. 안전상 실행이 불가능합니다. 명시적으로 사용자/ID를 사용해 주세요.");
        return;
      }
    }
    if (!member.kickable) {
      audit({ phase: "rejected", reason: "target_not_kickable" });
      await updateStatus(message, statusMessage, "대상 사용자는 역할 위계로 인해 강제 퇴장할 수 없습니다.");
      return;
    }
    await member.kick(reason);
    audit({ phase: "success", requiredPermission: "KickMembers", targetUserId: userId });
    const prompt = `봇으로서 사용자에게 이 관리 행동 결과를 자연스럽게 알려줘. 존댓말로 정중하게.

행동: 강제 퇴장

대상: ${member.displayName} (${userId})

이유: ${reason}

결과: 성공

권한 정보: 요청자 KickMembers, 봇 KickMembers`;
    const response = await callModel(prompt, { channel: message.channel });
    const permissionEmbed = buildPermissionUsageEmbed(["요청자: KickMembers", "봇: KickMembers"]);
    await statusMessage.edit(response, permissionEmbed ? { embeds: [permissionEmbed] } : {});
    return;
  }

  if (action === "ban") {
    await statusMessage.edit(`${message.author.displayName}님의 권한을 확인할게요`);
    if (!hasPerm(message.member, PermissionFlagsBits.BanMembers, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "BanMembers", reason: "missing_permission" });
      const prompt = `봇으로서 사용자에게 권한 부족을 정중하게 알려줘. 존댓말로.

요청한 행동: 밴

권한: BanMembers 부족`;
      const response = await callModel(prompt, { channel: message.channel });
      await statusMessage.edit(response);
      return;
    }
    if (!botMember.permissions?.has(PermissionFlagsBits.BanMembers)) {
      audit({ phase: "rejected", requiredPermission: "BanMembers(bot)", reason: "bot_missing_permission" });
      const prompt = `봇으로서 사용자에게 봇 권한 부족을 정중하게 알려줘. 존댓말로.

요청한 행동: 밴

봇 권한: BanMembers 부족`;
      const response = await callModel(prompt, { channel: message.channel });
      await statusMessage.edit(response);
      return;
    }

    const targetInput = actionObj.userId || actionObj.user || actionObj.username || actionObj.target;
    const deleteMessageSeconds = Number(actionObj.deleteMessageSeconds || 0);
    const reason = typeof actionObj.reason === "string" ? actionObj.reason : "AI moderation";

    if (Number.isNaN(deleteMessageSeconds) || deleteMessageSeconds < 0) {
      audit({ phase: "rejected", reason: "invalid_delete_message_seconds" });
      await updateStatus(message, statusMessage, "ban 파라미터(deleteMessageSeconds)가 올바르지 않습니다.");
      return;
    }

    const resolved = await resolveTargetMember(guild, targetInput, { safeFuzzy: false });
    if (!resolved.ok) {
      audit({ phase: "rejected", reason: "target_not_found" });
      await updateStatus(message, statusMessage, resolved.message);
      return;
    }

    const userId = resolved.member.id;
    if (!isExplicitTargetInInput(inputText, resolved.member, targetInput)) {
      if (resolved.matchType === "partial" || resolved.matchType === "partial_comparable") {
        await statusMessage.edit(`대상자가 명령문에 명확히 지정되지 않았습니다. <@${userId}> (${resolved.member.displayName}) 이 맞나요?`);
        throw new Error("target_confirmation_required");
      } else {
        audit({ phase: "rejected", reason: "target_not_explicit" });
        await updateStatus(message, statusMessage, "대상자가 명령문에 명확히 지정되지 않았습니다. 안전상 실행이 불가능합니다. 명시적으로 사용자/ID를 사용해 주세요.");
        return;
      }
    }
    if (!resolved.member.bannable) {
      audit({ phase: "rejected", reason: "target_not_bannable" });
      await updateStatus(message, statusMessage, "대상 사용자는 역할 위계로 인해 밴할 수 없습니다.");
      return;
    }
    await guild.members.ban(userId, { deleteMessageSeconds, reason });
    audit({ phase: "success", requiredPermission: "BanMembers", targetUserId: userId });
    const prompt = `봇으로서 사용자에게 이 관리 행동 결과를 자연스럽게 알려줘. 존댓말로 정중하게.

행동: 밴

대상: ${resolved.member.displayName} (${userId})

이유: ${reason}

결과: 성공

권한 정보: 요청자 BanMembers, 봇 BanMembers`;
    const response = await callModel(prompt, { channel: message.channel });
    const permissionEmbed = buildPermissionUsageEmbed(["요청자: BanMembers", "봇: BanMembers"]);
    await statusMessage.edit(response, permissionEmbed ? { embeds: [permissionEmbed] } : {});
    return;
  }

  if (action === "move_voice" || action === "move_voice_channel" || action === "move_member_voice") {
    if (!hasPerm(message.member, PermissionFlagsBits.MoveMembers, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "MoveMembers", reason: "missing_permission" });
      await updateStatus(message, statusMessage, "음성 채널 이동 권한이 없습니다.");
      return;
    }
    if (!botMember.permissions?.has(PermissionFlagsBits.MoveMembers)) {
      audit({ phase: "rejected", requiredPermission: "MoveMembers(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇에게 음성 채널 이동 권한이 없습니다.");
      return;
    }

    const rawTargetInput = actionObj.userId || actionObj.user || actionObj.username || actionObj.target;
    const channelIdInput = actionObj.channelId || actionObj.voiceChannelId || actionObj.voiceChannelID;
    const channelNameInput = actionObj.channelName || actionObj.voiceChannel || actionObj.channel;

    const allowSelfReference = String(rawTargetInput || "").trim().toLowerCase() === "self";
    let targetMember = null;
    let targetInput = rawTargetInput;

    if (allowSelfReference) {
      targetMember = message.member || (await guild.members.fetch(message.author.id).catch(() => null));
      targetInput = targetInput || message.author.id;
      if (!targetMember) {
        audit({ phase: "rejected", reason: "self_member_not_found" });
        await updateStatus(message, statusMessage, "요청자의 멤버 정보를 찾지 못했습니다.");
        return;
      }
    } else {
      const resolvedMember = await resolveTargetMember(guild, targetInput, { safeFuzzy: true });
      if (!resolvedMember.ok) {
        audit({ phase: "rejected", reason: "target_not_found" });
        await updateStatus(message, statusMessage, resolvedMember.message);
        return;
      }
      targetMember = resolvedMember.member;
    }

    if (!allowSelfReference && !isExplicitTargetInInput(inputText, targetMember, targetInput)) {
      audit({ phase: "rejected", reason: "target_not_explicit" });
      await updateStatus(message, statusMessage, "대상자가 명령문에 명확히 지정되지 않았습니다. 명시적으로 사용자/ID를 사용해 주세요.");
      return;
    }
    if (!targetMember.manageable) {
      audit({ phase: "rejected", reason: "target_not_manageable" });
      await updateStatus(message, statusMessage, "대상 사용자는 역할 위계로 인해 이동시킬 수 없습니다.");
      return;
    }

    const resolvedChannel = await resolveTargetVoiceChannelByAi(
      guild,
      channelIdInput,
      channelNameInput,
      inputText,
    );
    if (!resolvedChannel.ok) {
      if (resolvedChannel.reason === "target_channel_not_voice") {
        audit({ phase: "rejected", reason: "target_channel_not_voice" });
        await updateStatus(message, statusMessage, "지정한 채널이 음성 채널이 아닙니다.");
        return;
      }
      if (resolvedChannel.reason === "no_voice_channels") {
        audit({ phase: "rejected", reason: "no_voice_channels" });
        await updateStatus(message, statusMessage, "이 서버에서 이동 가능한 음성 채널을 찾지 못했습니다.");
        return;
      }
      if (resolvedChannel.reason === "missing_target") {
        audit({ phase: "rejected", reason: "missing_voice_channel_target" });
        await updateStatus(message, statusMessage, "이동할 음성 채널의 channelId 또는 채널명을 지정해 주세요.");
        return;
      }
      audit({ phase: "rejected", reason: "voice_channel_not_found_ai" });
      await updateStatus(
        message,
        statusMessage,
        `요청과 가장 가까운 음성 채널을 찾지 못했습니다. 채널명을 더 구체적으로 말씀해 주세요. (입력: ${resolvedChannel.query || "미지정"})`,
      );
      return;
    }

    const targetChannel = resolvedChannel.channel;
    const isVoiceChannel =
      targetChannel?.type === ChannelType.GuildVoice || targetChannel?.type === ChannelType.GuildStageVoice;
    if (!isVoiceChannel) {
      audit({ phase: "rejected", reason: "target_channel_not_voice" });
      await updateStatus(message, statusMessage, "대상 채널이 음성 채널이 아닙니다.");
      return;
    }
    if (!hasChannelPerm(targetChannel, botMember, PermissionFlagsBits.Connect)) {
      audit({ phase: "rejected", requiredPermission: "Connect(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇이 해당 음성 채널에 접속할 권한이 없습니다.");
      return;
    }
    if (!hasChannelPerm(targetChannel, botMember, PermissionFlagsBits.ViewChannel)) {
      audit({ phase: "rejected", requiredPermission: "ViewChannel(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇이 해당 음성 채널을 볼 권한이 없습니다.");
      return;
    }

    const freshTargetMember = await guild.members.fetch(targetMember.id).catch(() => targetMember);
    await freshTargetMember.voice.setChannel(targetChannel, "AI voice move");
    audit({ phase: "success", requiredPermission: "MoveMembers", targetUserId: freshTargetMember.id, targetChannelId: targetChannel.id });
    await updateStatus(message, statusMessage, `<@${freshTargetMember.id}> 사용자를 ${targetChannel.name}(으)로 이동했습니다.`, {
      permissionLines: ["요청자: MoveMembers", "봇: MoveMembers", "봇: Connect", "봇: ViewChannel"],
    });
    return;
  }

  if (
    action === "disconnect_voice" ||
    action === "voice_disconnect" ||
    action === "disconnect_member_voice"
  ) {
    if (!hasPerm(message.member, PermissionFlagsBits.MoveMembers, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "MoveMembers", reason: "missing_permission" });
      await updateStatus(message, statusMessage, "음성 채널 연결 해제 권한이 없습니다.");
      return;
    }
    if (!botMember.permissions?.has(PermissionFlagsBits.MoveMembers)) {
      audit({ phase: "rejected", requiredPermission: "MoveMembers(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇에게 음성 채널 연결 해제 권한이 없습니다.");
      return;
    }

    const rawTargetInput = actionObj.userId || actionObj.user || actionObj.username || actionObj.target;
    const allowSelfReference = String(rawTargetInput || "").trim().toLowerCase() === "self";
    let targetMember = null;
    let targetInput = rawTargetInput;

    if (allowSelfReference) {
      targetMember = message.member || (await guild.members.fetch(message.author.id).catch(() => null));
      targetInput = targetInput || message.author.id;
      if (!targetMember) {
        audit({ phase: "rejected", reason: "self_member_not_found" });
        await updateStatus(message, statusMessage, "요청자의 멤버 정보를 찾지 못했습니다.");
        return;
      }
    } else {
      const resolvedMember = await resolveTargetMember(guild, targetInput, { safeFuzzy: true });
      if (!resolvedMember.ok) {
        audit({ phase: "rejected", reason: "target_not_found" });
        await updateStatus(message, statusMessage, resolvedMember.message);
        return;
      }
      targetMember = resolvedMember.member;
    }

    if (!allowSelfReference && !isExplicitTargetInInput(inputText, targetMember, targetInput)) {
      audit({ phase: "rejected", reason: "target_not_explicit" });
      await updateStatus(message, statusMessage, "대상자가 명령문에 명확히 지정되지 않았습니다. 명시적으로 사용자/ID를 사용해 주세요.");
      return;
    }
    if (!targetMember.manageable) {
      audit({ phase: "rejected", reason: "target_not_manageable" });
      await updateStatus(message, statusMessage, "대상 사용자는 역할 위계로 인해 연결 해제할 수 없습니다.");
      return;
    }

    const freshTargetMember = await guild.members.fetch({ user: targetMember.id, force: true }).catch(() => targetMember);
    if (!freshTargetMember.voice?.channelId) {
      audit({ phase: "rejected", reason: "target_not_in_voice" });
      await updateStatus(message, statusMessage, `<@${freshTargetMember.id}> 사용자는 현재 통화방에 없습니다.`);
      return;
    }

    await freshTargetMember.voice.setChannel(null, "AI voice disconnect");
    audit({ phase: "success", requiredPermission: "MoveMembers", targetUserId: freshTargetMember.id });
    await updateStatus(message, statusMessage, `<@${freshTargetMember.id}> 사용자를 통화방에서 내보냈습니다.`, {
      permissionLines: ["요청자: MoveMembers", "봇: MoveMembers"],
    });
    return;
  }

  if (
    action === "voice_mute" ||
    action === "mute_voice" ||
    action === "voice_unmute" ||
    action === "unmute_voice" ||
    action === "voice_deafen" ||
    action === "deafen_voice" ||
    action === "voice_undeafen" ||
    action === "undeafen_voice"
  ) {
    const isDeafen = action.includes("deafen");
    const voiceAction = isDeafen ? "deafen" : "mute";
    const requiredPermission = isDeafen ? PermissionFlagsBits.DeafenMembers : PermissionFlagsBits.MuteMembers;
    const voiceActionName = isDeafen ? "헤드폰 음소거" : "마이크 음소거";
    const rawTargetInput = actionObj.userId || actionObj.user || actionObj.username || actionObj.target;
    const allowSelfReference = isSelfTarget(rawTargetInput);
    const explicitlyEnabled = actionObj.enabled === true ? true : actionObj.enabled === false ? false : null;
    const autoEnabled = action === "voice_unmute" || action === "unmute_voice" || action === "voice_undeafen" || action === "undeafen_voice" ? false : true;
    const enabled = explicitlyEnabled === null ? autoEnabled : explicitlyEnabled;

    if (!allowSelfReference && !hasPerm(message.member, requiredPermission, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: requiredPermission === PermissionFlagsBits.DeafenMembers ? "DeafenMembers" : "MuteMembers", reason: "missing_permission" });
      await updateStatus(message, statusMessage, `${voiceActionName} 권한이 없습니다.`);
      return;
    }
    if (!botMember.permissions?.has(requiredPermission)) {
      audit({ phase: "rejected", requiredPermission: requiredPermission === PermissionFlagsBits.DeafenMembers ? "DeafenMembers(bot)" : "MuteMembers(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, `봇에게 ${voiceActionName} 권한이 없습니다.`);
      return;
    }

    let targetMember = null;
    if (allowSelfReference) {
      targetMember = message.member || (await guild.members.fetch(message.author.id).catch(() => null));
      if (!targetMember) {
        audit({ phase: "rejected", reason: "self_member_not_found" });
        await updateStatus(message, statusMessage, "요청자의 멤버 정보를 찾지 못했습니다.");
        return;
      }
    } else {
      const resolvedMember = await resolveTargetMember(guild, rawTargetInput, { safeFuzzy: true });
      if (!resolvedMember.ok) {
        audit({ phase: "rejected", reason: "target_not_found" });
        await updateStatus(message, statusMessage, resolvedMember.message);
        return;
      }
      targetMember = resolvedMember.member;
    }

    if (!targetMember.voice?.channelId) {
      audit({ phase: "rejected", reason: "target_not_in_voice" });
      await updateStatus(message, statusMessage, `<@${targetMember.id}> 사용자는 현재 통화방에 없습니다.`);
      return;
    }

    if (!allowSelfReference && !isExplicitTargetInInput(inputText, targetMember, rawTargetInput)) {
      audit({ phase: "rejected", reason: "target_not_explicit" });
      await updateStatus(message, statusMessage, "대상자가 명령문에 명확히 지정되지 않았습니다. 명시적으로 사용자/ID를 사용해 주세요.");
      return;
    }
    if (!targetMember.manageable) {
      audit({ phase: "rejected", reason: "target_not_manageable" });
      await updateStatus(message, statusMessage, "대상 사용자는 역할 위계로 인해 상태를 변경할 수 없습니다.");
      return;
    }

    const freshTargetMember = await guild.members.fetch({ user: targetMember.id, force: true }).catch(() => targetMember);
    try {
      if (voiceAction === "deafen") {
        await freshTargetMember.voice.setDeaf(enabled, "AI voice deafen");
      } else {
        await freshTargetMember.voice.setMute(enabled, "AI voice mute");
      }
    } catch (error) {
      audit({ phase: "failed", reason: "voice_state_update_failed", error: error.code, targetUserId: freshTargetMember.id });
      logError("action.voice_state", error, { targetUserId: freshTargetMember.id, action: voiceAction, enabled });
      await updateStatus(message, statusMessage, `${voiceActionName} 동작 중 오류가 발생했습니다.`);
      return;
    }

    const resultText = enabled
      ? `<@${freshTargetMember.id}> 사용자의 ${voiceActionName}를 적용했습니다.`
      : `<@${freshTargetMember.id}> 사용자의 ${voiceActionName}를 해제했습니다.`;
    audit({ phase: "success", requiredPermission: allowSelfReference ? null : requiredPermission === PermissionFlagsBits.DeafenMembers ? "DeafenMembers" : "MuteMembers", targetUserId: freshTargetMember.id });
    await updateStatus(message, statusMessage, resultText, {
      permissionLines: allowSelfReference
        ? [`봇: ${requiredPermission === PermissionFlagsBits.DeafenMembers ? "DeafenMembers" : "MuteMembers"}`]
        : [`요청자: ${requiredPermission === PermissionFlagsBits.DeafenMembers ? "DeafenMembers" : "MuteMembers"}`, `봇: ${requiredPermission === PermissionFlagsBits.DeafenMembers ? "DeafenMembers" : "MuteMembers"}`],
    });
    return;
  }

  if (action === "create_text_channel") {
    if (!hasPerm(message.member, PermissionFlagsBits.ManageChannels, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "ManageChannels", reason: "missing_permission" });
      await updateStatus(message, statusMessage, "채널 생성 권한이 없습니다.");
      return;
    }
    if (!botMember.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      audit({ phase: "rejected", requiredPermission: "ManageChannels(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇에게 채널 생성 권한이 없습니다.");
      return;
    }

    const name = String(actionObj.name || "").trim();
    const topic = typeof actionObj.topic === "string" ? actionObj.topic : undefined;

    if (!name) {
      audit({ phase: "rejected", reason: "missing_channel_name" });
      await updateStatus(message, statusMessage, "create_text_channel 파라미터(name)가 필요합니다.");
      return;
    }

    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      topic,
    });

    audit({ phase: "success", requiredPermission: "ManageChannels", targetChannelId: created.id });
    await updateStatus(message, statusMessage, `채널을 성공적으로 생성했습니다: <#${created.id}>`, {
      permissionLines: ["요청자: ManageChannels", "봇: ManageChannels"],
    });
    return;
  }

  if (action === "assign_role") {
    if (!hasPerm(message.member, PermissionFlagsBits.ManageRoles, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "ManageRoles", reason: "missing_permission" });
      await updateStatus(message, statusMessage, "역할 관리 권한이 없습니다.");
      return;
    }
    if (!botMember.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      audit({ phase: "rejected", requiredPermission: "ManageRoles(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇에게 역할 관리 권한이 없습니다.");
      return;
    }

    const targetInput = actionObj.userId || actionObj.user || actionObj.username || actionObj.target;
    const roleInput = actionObj.roleId || actionObj.role || actionObj.roleName;

    const resolvedMember = await resolveTargetMember(guild, targetInput, { safeFuzzy: true });
    if (!resolvedMember.ok) {
      audit({ phase: "rejected", reason: "target_not_found" });
      await updateStatus(message, statusMessage, resolvedMember.message);
      return;
    }

    const resolvedRole = await resolveTargetRole(guild, roleInput);
    if (!resolvedRole.ok) {
      audit({ phase: "rejected", reason: "role_not_found" });
      await updateStatus(message, statusMessage, resolvedRole.message);
      return;
    }

    const member = resolvedMember.member;
    const role = resolvedRole.role;
    if (!isExplicitTargetInInput(inputText, member, targetInput)) {
      audit({ phase: "rejected", reason: "target_not_explicit" });
      await updateStatus(message, statusMessage, "대상자가 명령문에 명확히 지정되지 않았습니다. 안전상 실행이 불가능합니다. 명시적으로 사용자/ID를 사용해 주세요.");
      return;
    }
    if (!member.manageable) {
      audit({ phase: "rejected", reason: "target_not_manageable" });
      await updateStatus(message, statusMessage, "대상 사용자는 역할 위계로 인해 역할 변경이 불가능합니다.");
      return;
    }
    if (!role.editable) {
      audit({ phase: "rejected", reason: "role_not_editable" });
      await updateStatus(message, statusMessage, "해당 역할은 봇보다 상위이거나 관리 불가능한 역할입니다.");
      return;
    }
    await member.roles.add(role);
    audit({ phase: "success", requiredPermission: "ManageRoles", targetUserId: member.id, targetRoleId: role.id });
    await updateStatus(message, statusMessage, `<@${member.id}> 사용자에게 ${role.name} 역할을 부여했습니다.`, {
      permissionLines: ["요청자: ManageRoles", "봇: ManageRoles"],
    });
    return;
  }

  if (action === "remove_role") {
    if (!hasPerm(message.member, PermissionFlagsBits.ManageRoles, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "ManageRoles", reason: "missing_permission" });
      await updateStatus(message, statusMessage, "역할 관리 권한이 없습니다.");
      return;
    }
    if (!botMember.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      audit({ phase: "rejected", requiredPermission: "ManageRoles(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇에게 역할 관리 권한이 없습니다.");
      return;
    }

    const targetInput = actionObj.userId || actionObj.user || actionObj.username || actionObj.target;
    const roleInput = actionObj.roleId || actionObj.role || actionObj.roleName;

    const resolvedMember = await resolveTargetMember(guild, targetInput, { safeFuzzy: true });
    if (!resolvedMember.ok) {
      audit({ phase: "rejected", reason: "target_not_found" });
      await updateStatus(message, statusMessage, resolvedMember.message);
      return;
    }

    const resolvedRole = await resolveTargetRole(guild, roleInput);
    if (!resolvedRole.ok) {
      audit({ phase: "rejected", reason: "role_not_found" });
      await updateStatus(message, statusMessage, resolvedRole.message);
      return;
    }

    const member = resolvedMember.member;
    const role = resolvedRole.role;
    if (!isExplicitTargetInInput(inputText, member, targetInput)) {
      audit({ phase: "rejected", reason: "target_not_explicit" });
      await updateStatus(message, statusMessage, "대상자가 명령문에 명확히 지정되지 않았습니다. 안전상 실행이 불가능합니다. 명시적으로 사용자/ID를 사용해 주세요.");
      return;
    }
    if (!member.manageable) {
      audit({ phase: "rejected", reason: "target_not_manageable" });
      await updateStatus(message, statusMessage, "대상 사용자는 역할 위계로 인해 역할 변경이 불가능합니다.");
      return;
    }
    if (!role.editable) {
      audit({ phase: "rejected", reason: "role_not_editable" });
      await updateStatus(message, statusMessage, "해당 역할은 봇보다 상위이거나 관리 불가능한 역할입니다.");
      return;
    }
    await member.roles.remove(role);
    audit({ phase: "success", requiredPermission: "ManageRoles", targetUserId: member.id, targetRoleId: role.id });
    await updateStatus(message, statusMessage, `<@${member.id}> 사용자에게서 ${role.name} 역할을 제거했습니다.`, {
      permissionLines: ["요청자: ManageRoles", "봇: ManageRoles"],
    });
    return;
  }

  if (action === "create_role") {
    if (!hasPerm(message.member, PermissionFlagsBits.ManageRoles, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "ManageRoles", reason: "missing_permission" });
      await updateStatus(message, statusMessage, "역할 관리 권한이 없습니다.");
      return;
    }
    if (!botMember.permissions?.has(PermissionFlagsBits.ManageRoles)) {
      audit({ phase: "rejected", requiredPermission: "ManageRoles(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇에게 역할 관리 권한이 없습니다.");
      return;
    }

    const roleName = String(actionObj.roleName || actionObj.name || actionObj.role || "").trim();
    if (!roleName) {
      audit({ phase: "rejected", reason: "missing_role_name" });
      await updateStatus(message, statusMessage, "create_role 파라미터(name 또는 roleName)가 필요합니다.");
      return;
    }

    const permissionsInput = actionObj.permissions ?? actionObj.perms ?? actionObj.permission;
    const { validPermissions, invalidTokens } = resolvePermissionNames(permissionsInput);
    if (validPermissions.length === 0) {
      audit({ phase: "rejected", reason: "invalid_permissions" });
      const availableSample = listPermissionExamples(10).join(", ");
      await updateStatus(message, statusMessage, `유효한 권한이 없습니다. 예시: ${availableSample}`);
      return;
    }

    const createdRole = await guild.roles.create({
      name: roleName,
      permissions: validPermissions,
      reason: "AI 역할 생성",
    });

    audit({
      phase: "success",
      requiredPermission: "ManageRoles",
      targetRoleId: createdRole.id,
      permissions: validPermissions,
    });

    const invalidSuffix = invalidTokens.length > 0
      ? `\n(무시된 권한: ${invalidTokens.join(", ")})`
      : "";
    await updateStatus(
      message,
      statusMessage,
      `<@&${createdRole.id}> 역할을 생성했습니다.\n권한: ${validPermissions.join(", ")}${invalidSuffix}`,
      { permissionLines: ["요청자: ManageRoles", "봇: ManageRoles"] },
    );
    return;
  }

  if (action === "rename_channel") {
    if (!hasPerm(message.member, PermissionFlagsBits.ManageChannels, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "ManageChannels", reason: "missing_permission" });
      await updateStatus(message, statusMessage, "채널 편집 권한이 없습니다.");
      return;
    }
    if (!botMember.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      audit({ phase: "rejected", requiredPermission: "ManageChannels(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇에게 채널 편집 권한이 없습니다.");
      return;
    }

    const channelId = resolveChannelIdInput(actionObj.channelId, message.channel.id);
    const name = String(actionObj.name || "").trim();

    if (!channelId) {
      audit({ phase: "rejected", reason: "invalid_channel_id" });
      await updateStatus(message, statusMessage, "필수 파라미터 channelId(채널 ID)가 필요합니다.");
      return;
    }

    if (!name) {
      audit({ phase: "rejected", reason: "missing_channel_name" });
      await updateStatus(message, statusMessage, "rename_channel 파라미터(name)가 필요합니다.");
      return;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      audit({ phase: "rejected", reason: "channel_not_found" });
      await updateStatus(message, statusMessage, "채널을 찾을 수 없습니다.");
      return;
    }
    if ("manageable" in channel && channel.manageable === false) {
      audit({ phase: "rejected", reason: "channel_not_manageable" });
      await updateStatus(message, statusMessage, "대상 채널은 봇 권한/위계로 인해 이름 변경이 불가능합니다.");
      return;
    }

    await channel.setName(name);
    audit({ phase: "success", requiredPermission: "ManageChannels", targetChannelId: channel.id });
    await updateStatus(message, statusMessage, `채널 이름을 변경했습니다: ${name}`, {
      permissionLines: ["요청자: ManageChannels", "봇: ManageChannels"],
    });
    return;
  }

  if (action === "delete_channel") {
    if (!hasPerm(message.member, PermissionFlagsBits.ManageChannels, message.author?.id)) {
      audit({ phase: "rejected", requiredPermission: "ManageChannels", reason: "missing_permission" });
      await updateStatus(message, statusMessage, "채널 관리 권한이 없습니다.");
      return;
    }
    if (!botMember.permissions?.has(PermissionFlagsBits.ManageChannels)) {
      audit({ phase: "rejected", requiredPermission: "ManageChannels(bot)", reason: "bot_missing_permission" });
      await updateStatus(message, statusMessage, "봇에게 채널 관리 권한이 없습니다.");
      return;
    }

    const resolved = await resolveTargetChannel(
      guild,
      actionObj.channelId,
      actionObj.name || actionObj.channelName || actionObj.channel,
      inputText,
      message.channel.id,
    );
    if (!resolved.ok) {
      if (resolved.reason === "missing_target") {
        audit({ phase: "rejected", reason: "missing_channel_target" });
        await updateStatus(message, statusMessage, "삭제할 채널의 channelId 또는 채널명을 지정해 주세요.");
        return;
      }
      if (resolved.reason === "ambiguous") {
        audit({ phase: "rejected", reason: "channel_ambiguous" });
        await updateStatus(message, statusMessage, `동일한 이름의 채널이 여러 개입니다. channelId로 다시 지정해 주세요. (입력: ${resolved.query})`);
        return;
      }
      audit({ phase: "rejected", reason: "channel_not_found" });
      await updateStatus(message, statusMessage, `채널을 찾을 수 없습니다. (입력: ${resolved.query || "미지정"})`);
      return;
    }
    const channel = resolved.channel;
    const channelId = channel.id;

    // 현재 채널은 삭제하지 못하도록 보호
    if (channel.id === message.channel.id) {
      audit({ phase: "rejected", reason: "cannot_delete_current_channel" });
      await updateStatus(message, statusMessage, "현재 채널은 삭제할 수 없습니다.");
      return;
    }
    if ("deletable" in channel && channel.deletable === false) {
      audit({ phase: "rejected", reason: "channel_not_deletable" });
      await updateStatus(message, statusMessage, "대상 채널은 봇 권한/위계로 인해 삭제할 수 없습니다.");
      return;
    }

    const channelName = channel.name;
    await channel.delete();
    audit({ phase: "success", requiredPermission: "ManageChannels", targetChannelId: channelId });
    await updateStatus(message, statusMessage, `채널 "${channelName}"을(를) 삭제했습니다.`, {
      permissionLines: ["요청자: ManageChannels", "봇: ManageChannels"],
    });
    return;
  }

  audit({ phase: "rejected", reason: "unsupported_action" });
  await updateStatus(message, statusMessage, `지원하지 않는 action입니다: ${action}`);
  return;
  } catch (error) {
    const reasonText = `${error?.code || "unknown"}:${error?.message || String(error)}`;
    audit({ phase: "error", reason: reasonText });
    logError("executeAction", error, {
      action,
      guildId: message.guild?.id || null,
      userId: message.author?.id || null,
      inputText,
    });
    await updateStatus(message, statusMessage, getActionErrorMessage(error));
  }
}
