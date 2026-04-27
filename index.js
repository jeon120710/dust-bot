﻿import { 
  Client, 
  GatewayIntentBits, 
  PermissionFlagsBits, 
  MessageFlags, 
  EmbedBuilder,
  Events
} from "discord.js";
import { PREFIX, DISCORD_TOKEN, ABSOLUTE_POWER_USER_ID } from "./config.js";
import fs from "node:fs";
import path from "node:path";
import { 
  getRecentConversation, 
  saveConversation, 
  clearConversation
} from "./database.js";
import {
  formatHistoryForPrompt,
  parseAiAction,
  looksLikeDoneMessage,
  normalizeSnowflake,
  safeParseJsonObject,
  appendCompletionMark,
} from "./utils.js";
import { callModel, getCurrentModelName } from "./ai.js";
import {
  tryHandleMentionRequest,
  tryHandleMemberLookupQuestion,
  tryHandleMemberPermissionLookupQuestion,
  tryHandleRoleMemberLookupQuestion,
  tryHandleServerOwnerLookupQuestion,
  handleBatchTimeout,
  handleBatchRole,
  buildBatchTimeoutSummary,
  buildBatchRoleSummary,
  createRoleWithPermissions,
  setRolePermissions,
} from "./handlers.js";
import { resolveTargetRole } from "./roles.js";
import { executeAction } from "./actions.js";
import { logActionAudit, logCommandTrigger, logError } from "./logger.js";
import { tryHandleTypingGameSubmission, handleTypingInteraction } from "./typing.js";
import { registerSlashCommands } from "./commands.js";
import { buildPermissionUsageEmbed } from "./permissionEmbed.js";
import { buildWebSearchSourcesEmbed } from "./sourceEmbed.js";
import { startRoleScheduler, setLogChannelId } from "./scheduler.js";
import { handleSpaceInteraction } from "./space.js";
import { reloadAssets } from "./assets.js";


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: ["MESSAGE", "REACTION"],
});

function getShardOptionsFromEnv() {
  const shardIdRaw = process.env.SHARD_ID;
  const shardCountRaw = process.env.SHARD_COUNT;
  if (shardIdRaw === undefined || shardCountRaw === undefined) return {};
  const shardId = Number(shardIdRaw);
  const shardCount = Number(shardCountRaw);
  if (Number.isNaN(shardId) || Number.isNaN(shardCount)) return {};
  return { shards: [shardId], shardCount };
}

// No manual voiceAdapterCreator assignment needed; discord.js provides it.
function normalizeRejectReason(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  return raw
    .replace(/^실행되지 않았습니다\.?\s*사유:\s*/i, "")
    .replace(/^사유:\s*/i, "")
    .trim();
}

function buildPendingKey(message) {
  const userId = message.author?.id || "unknown";
  const guildId = message.guild?.id || "dm";
  const channelId = message.channel?.id || "unknown";
  return `${userId}:${guildId}:${channelId}`;
}

const RESTART_CONFIRM_TTL_MS = 60_000;
const SHUTDOWN_CONFIRM_TTL_MS = 60_000;
const PRIVILEGED_ACTION_TTL_MS = 60_000;
const TARGET_CONFIRM_TTL_MS = 60_000;
const BATCH_ACTION_TTL_MS = 60_000;
const pendingRestartConfirm = new Map();
const pendingShutdownConfirm = new Map();
const pendingPrivilegedAction = new Map();
const pendingTargetConfirm = new Map();
const pendingReactionConfirm = new Map(); // statusMessageId -> {userId, actionType, requestedAt}
const pendingBatchAction = new Map(); // pendingKey -> {actionType, durationMinutes, excludeRoleId, roleId, mode, requestedAt}
const PRIVILEGED_ACTIONS = new Set([
  "send",
  "send_dm",
  "delete_message",
  "delete_messages",
  "timeout",
  "kick",
  "ban",
  "move_voice",
  "move_voice_channel",
  "move_member_voice",
  "disconnect_voice",
  "voice_disconnect",
  "disconnect_member_voice",
  "voice_mute",
  "mute_voice",
  "voice_unmute",
  "unmute_voice",
  "voice_deafen",
  "deafen_voice",
  "voice_undeafen",
  "undeafen_voice",
  "assign_role",
  "remove_role",
  "create_role",
  "create_text_channel",
  "rename_channel",
  "delete_channel",
]);

function escapePromptValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function classifyBinaryConfirmation(text, options = {}) {
  const {
    targetLabel = "실행 진행",
    confirmRule = "confirm: 실행을 지금 진행하라고 명확히 동의/승인",
    cancelRule = "cancel: 실행을 하지 말라고 명확히 거부/취소",
  } = options;

  const prompt = `
당신은 디스코드 봇 운영 보조 분류기입니다.
아래 사용자 메시지가 "${targetLabel}"에 대한 명확한 확인인지 판단하세요.

규칙:
- ${confirmRule}
- ${cancelRule}
- other: 그 외 모든 경우(애매하면 other)
- 출력은 JSON 1개만.

출력 형식:
{"decision":"confirm|cancel|other","reason":"짧은 판단 근거"}

메시지:
"${escapePromptValue(text)}"
`;

  try {
    const resultText = await callModel(prompt);
    const parsed = safeParseJsonObject(resultText);
    if (parsed && typeof parsed.decision === "string") {
      const decision = parsed.decision;
      if (decision === "confirm" || decision === "cancel" || decision === "other") {
        return {
          decision,
          reason: typeof parsed.reason === "string" ? parsed.reason : "",
        };
      }
    }
  } catch {
    // swallow and fall through
  }

  return { decision: "other", reason: "invalid_ai_response" };
}

async function classifyRestartConfirmation(text) {
  return classifyBinaryConfirmation(text, {
    targetLabel: "재시작 진행",
    confirmRule: "confirm: 재시작을 지금 진행하라고 명확히 동의/승인",
    cancelRule: "cancel: 재시작을 하지 말라고 명확히 거부/취소",
  });
}

async function classifyShutdownConfirmation(text) {
  return classifyBinaryConfirmation(text, {
    targetLabel: "종료 진행",
    confirmRule: "confirm: 종료를 지금 진행하라고 명확히 동의/승인",
    cancelRule: "cancel: 종료를 하지 말라고 명확히 거부/취소",
  });
}

async function classifyPrivilegedConfirmation(text) {
  return classifyBinaryConfirmation(text, {
    targetLabel: "실행 진행",
    confirmRule: "confirm: 실행을 지금 진행하라고 명확히 동의/승인",
    cancelRule: "cancel: 실행을 하지 말라고 명확히 거부/취소",
  });
}

async function classifyTargetConfirmation(text) {
  return classifyBinaryConfirmation(text, {
    targetLabel: "유저 확인",
    confirmRule: "confirm: 이 유저가 맞다고 명확히 동의/승인 (예, 응, 맞아, yes 등)",
    cancelRule: "cancel: 이 유저가 아니라고 명확히 거부/취소 (아니, 틀려, no 등)",
  });
}

async function classifyPowerControlIntent(text) {
  const prompt = `
당신은 디스코드 봇 운영 보조 분류기입니다.
아래 메시지가 봇 재시작/종료 요청인지 분류하세요.

규칙:
- restart: 재시작 요청
- shutdown: 종료 요청
- none: 그 외 모든 경우
- 애매하면 반드시 none
- 출력은 JSON 1개만

출력 형식:
{"intent":"restart|shutdown|none","reason":"짧은 판단 근거"}

메시지:
"${String(text || "").replace(/"/g, '\\"')}"
`;

  try {
    const resultText = await callModel(prompt);
    const parsed = safeParseJsonObject(resultText);
    const intent = String(parsed?.intent || "").toLowerCase();
    if (intent === "restart" || intent === "shutdown" || intent === "none") {
      return {
        intent,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
    }
  } catch {
    // swallow and fall through
  }

  return { intent: "none", reason: "invalid_ai_response" };
}

async function classifyDirectCommandIntent(text) {
  const prompt = `
당신은 디스코드 봇의 직접 명령 분류기입니다.
아래 메시지가 reset-memory 직접 명령인지 판단하세요.

규칙:
- reset_memory: 메시지가 메모리 초기화 명령을 직접 실행하려는 경우
- none: 그 외 모든 경우
- 애매하면 none
- 출력은 JSON 1개만

출력 형식:
{"intent":"reset_memory|none","argsText":"명령어 뒤 인자 문자열","reason":"짧은 판단 근거"}

argsText 규칙:
- intent가 reset_memory일 때만 사용
- 명령어 토큰(!reset-memory 등)을 제거한 나머지 문자열
- 인자가 없으면 빈 문자열

메시지:
"${String(text || "").replace(/"/g, '\\"')}"
`;

  try {
    const resultText = await callModel(prompt);
    const parsed = safeParseJsonObject(resultText);
    const intent = String(parsed?.intent || "").toLowerCase();
    if (intent === "reset_memory" || intent === "none") {
      return {
        intent,
        argsText: intent === "reset_memory" ? String(parsed?.argsText || "").trim() : "",
        reason: typeof parsed?.reason === "string" ? parsed.reason : "",
      };
    }
  } catch {
    // swallow and fall through
  }

  return { intent: "none", argsText: "", reason: "invalid_ai_response" };
}

function clampBulkDeleteCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count <= 0) return 0;
  return Math.min(count, 100);
}

function clampMentionCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count <= 0) return 1;
  return Math.min(count, 20);
}

function splitWhitespaceTokens(text) {
  const input = String(text || "").trim();
  if (!input) return [];
  return input.split(" ").map((part) => part.trim()).filter(Boolean);
}

function normalizeShortcutIntent(parsed) {
  const shortcutType = String(parsed?.shortcutType || "none");
  const shortcutTarget = String(parsed?.shortcutTarget || "").trim();
  const shortcutCount = clampMentionCount(parsed?.shortcutCount ?? 1);
  const reason = typeof parsed?.reason === "string" ? parsed.reason : "";

  if (shortcutType === "mention" && shortcutTarget) {
    return { type: shortcutType, target: shortcutTarget, count: shortcutCount, reason };
  }
  if ((shortcutType === "member_lookup" || shortcutType === "role_member_lookup") && shortcutTarget) {
    return { type: shortcutType, target: shortcutTarget, count: 1, reason };
  }
  if (shortcutType === "member_permission_lookup") {
    return { type: shortcutType, target: shortcutTarget, count: 1, reason };
  }
  if (shortcutType === "server_owner_lookup" || shortcutType === "none") {
    return { type: shortcutType, target: "", count: 1, reason };
  }
  return { type: "none", target: "", count: 1, reason: "invalid_shortcut_payload" };
}

async function classifyCommandPlan(input) {
  const text = String(input || "").trim();
  if (!text) {
    return {
      useWebSearch: false,
      adminRequest: false,
      bulkDeleteCount: 0,
      serverInfoIntent: "none",
      shortcutIntent: { type: "none", target: "", count: 1, reason: "empty_input" },
      reason: "empty_input",
    };
  }

  const prompt = `
당신은 디스코드 봇의 통합 요청 분류기입니다.
아래 사용자 메시지의 라우팅 정보를 JSON으로 분류하세요.

출력 필드:
- useWebSearch: true|false
- adminRequest: true|false
- bulkDeleteCount: 0~100 정수
- serverInfoIntent: "server_member_count" | "server_role_list" | "none"
- shortcutType: "mention" | "member_lookup" | "role_member_lookup" | "member_permission_lookup" | "server_owner_lookup" | "none"
- shortcutTarget: 문자열
- shortcutCount: 1~20 정수
- reason: 짧은 판단 근거

판단 규칙:
1) useWebSearch
- 최신/현재/실시간 정보, 뉴스, 외부 사실 확인, 웹 검색 요청이면 true
- 서버 내부 관리 요청(타임아웃/킥/밴/역할/채널/메시지 삭제 등)이나 일반 대화면 false

2) adminRequest
- 서버 관리 실행 요청(타임아웃, 킥, 밴, 역할 변경, 채널 생성/삭제/이름변경, 메시지 삭제, 공지/강제 전송, 음성 채널 이동 등)이면 true
- 일반 대화, 설명 요청, 잡담이면 false

3) bulkDeleteCount
- "최근 메시지 N개 삭제"처럼 현재 채널의 대량 삭제 의도가 명확하면 N(1~100)
- 그 외에는 0

4) serverInfoIntent
- 서버 멤버 수/인원 수/사람 수 조회면 "server_member_count"
- 서버 역할 목록/롤 목록/역할 리스트 조회면 "server_role_list"
- 아니면 "none"

5) shortcutType / shortcutTarget / shortcutCount
- mention: 특정 사용자를 멘션해 달라는 요청
- member_lookup: 특정 멤버 자체를 찾는 요청
- role_member_lookup: 특정 역할을 가진 멤버 목록 요청
- member_permission_lookup: 특정 멤버의 권한 조회 요청
- server_owner_lookup: 서버장/오너가 누구인지 묻는 요청
- 이동/변경/생성/삭제/타임아웃/킥/밴 같은 "실행 요청"이면 shortcutType은 반드시 none
- 해당 없거나 모호하면 none
- mention일 때만 shortcutCount 사용(1~20), target 필수
- member_lookup/role_member_lookup일 때 target 필수
- member_permission_lookup은 target이 없어도 허용(비우면 요청자 본인 기준)
- member_permission_lookup에서 대상이 "나/내/저/me/my/myself/본인"이면 target은 반드시 빈 문자열로 출력
- role_member_lookup의 target은 역할명만 남기고 "역할/롤/멤버/사람/알려줘/조회" 같은 설명어는 제거
- server_owner_lookup/none은 target 비움

보수적으로 판단하세요. 애매하면 false/0.
반드시 JSON 객체 1개만 출력하세요.

메시지:
"${text.replace(/"/g, '\\"')}"
`;

  try {
    const resultText = await callModel(prompt);
    const parsed = safeParseJsonObject(resultText);
    if (!parsed || typeof parsed !== "object") {
      return {
        useWebSearch: false,
        adminRequest: false,
        bulkDeleteCount: 0,
        serverInfoIntent: "none",
        shortcutIntent: { type: "none", target: "", count: 1, reason: "invalid_ai_response" },
        reason: "invalid_ai_response",
      };
    }

    const useWebSearch = parsed.useWebSearch === true;
    const adminRequest = parsed.adminRequest === true;
    const bulkDeleteCount = clampBulkDeleteCount(parsed.bulkDeleteCount ?? 0);
    const serverInfoIntentRaw = String(parsed.serverInfoIntent || "none");
    const serverInfoIntent =
      serverInfoIntentRaw === "server_member_count" || serverInfoIntentRaw === "server_role_list"
        ? serverInfoIntentRaw
        : "none";
    const shortcutIntent = normalizeShortcutIntent(parsed);
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";

    return {
      useWebSearch,
      adminRequest,
      bulkDeleteCount,
      serverInfoIntent,
      shortcutIntent,
      reason,
    };
  } catch (err) {
    logError("command.plan.classify", err, { input: text });
    return {
      useWebSearch: false,
      adminRequest: false,
      bulkDeleteCount: 0,
      serverInfoIntent: "none",
      shortcutIntent: { type: "none", target: "", count: 1, reason: "classify_error" },
      reason: "classify_error",
    };
  }
}

async function performRestart(client, message) {
  try {
    await message.reply("봇을 재시작합니다.");
  } catch {
    // ignore reply errors
  }

  let respawned = false;
  if (client.shard?.respawnAll) {
    try {
      await client.shard.respawnAll({
        shardDelay: 5000,
        respawnDelay: 500,
        timeout: 30000,
      });
      respawned = true;
    } catch {
      respawned = false;
    }
  }

  if (respawned) {
    return;
  }

  try {
    await client.destroy();
  } finally {
    process.exit(0);
  }
}

async function performShutdown(client, message) {
  try {
    await message.reply("봇을 종료합니다.");
  } catch {
    // ignore reply errors
  }
  try {
    if (client.shard) {
      try {
        client.shard.send({ type: "shutdown" });
      } catch {
        // ignore shard IPC errors
      }
    }
    await client.destroy();
  } finally {
    process.exit(0);
  }
}

function normalizeCallModelResult(result) {
  if (typeof result === "string") return { text: result, sources: [] };
  if (result && typeof result === "object") {
    return {
      text: typeof result.text === "string" ? result.text : "",
      sources: Array.isArray(result.sources) ? result.sources : [],
    };
  }
  return { text: "", sources: [] };
}

const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_SAFE_CHUNK = 1900;
const CHANNEL_CONTEXT_FETCH_LIMIT = 15;
const CHANNEL_CONTEXT_USE_LIMIT = 10;
const CHANNEL_CONTEXT_LINE_LIMIT = 180;
const CODE_CONTEXT_MAX_SNIPPETS = 6;
const CODE_CONTEXT_MAX_LINE_LEN = 180;
const CODE_REFERENCE_FILES = [
  "index.js",
  "actions.js",
  "handlers.js",
  "ai.js",
  "commands.js",
  "database.js",
  "typing.js",
  "space.js",
  "utils.js",
  "roles.js",
  "permissions.js",
  "scheduler.js",
];
const codeFileCache = new Map();

function buildMessageEmbeds(options = {}) {
  const embeds = [];
  const permissionEmbed = buildPermissionUsageEmbed(options.permissionLines);
  if (permissionEmbed) embeds.push(permissionEmbed);
  const sourceEmbed = buildWebSearchSourcesEmbed(options.sources);
  if (sourceEmbed) embeds.push(sourceEmbed);
  return embeds;
}

function splitMessage(text, maxLen = DISCORD_SAFE_CHUNK) {
  const input = String(text || "");
  if (!input) return [""];
  if (input.length <= maxLen) return [input];

  const chunks = [];
  let remaining = input;

  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    let cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (cut < Math.floor(maxLen * 0.6)) {
      cut = maxLen;
    }
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks.length > 0 ? chunks : [input.slice(0, maxLen)];
}

async function sendChunkedMessage(message, statusMessage, text, options = {}) {
  const completedText = appendCompletionMark(text);
  const chunks = splitMessage(completedText, DISCORD_SAFE_CHUNK);
  if (chunks.length === 0) return;

  const embeds = buildMessageEmbeds(options);
  const firstPayload = embeds.length > 0 ? { content: chunks[0], embeds } : chunks[0];
  let firstSent = false;

  try {
    await statusMessage.edit(firstPayload);
    firstSent = true;
  } catch {
    try {
      await message.reply(firstPayload);
      firstSent = true;
    } catch {
      // fall through
    }
  }

  if (chunks.length <= 1) return;

  const channel = message.channel?.isTextBased?.() ? message.channel : null;
  for (let i = 1; i < chunks.length; i += 1) {
    const payload = chunks[i];
    try {
      if (channel) {
        await channel.send(payload);
      } else if (!firstSent) {
        await message.reply(payload);
      }
    } catch {
      // ignore follow-up failures
    }
  }
}

async function updateStatusWithOptionalPermission(message, statusMessage, text, options = {}) {
  const completedText = appendCompletionMark(text);
  const embeds = buildMessageEmbeds(options);
  const payload = embeds.length > 0 ? { content: completedText, embeds } : completedText;

  try {
    if (typeof payload === "string" && payload.length > DISCORD_MESSAGE_LIMIT) {
      await sendChunkedMessage(message, statusMessage, payload, options);
      return;
    }
    if (payload?.content && payload.content.length > DISCORD_MESSAGE_LIMIT) {
      await sendChunkedMessage(message, statusMessage, payload.content, options);
      return;
    }
    await statusMessage.edit(payload);
  } catch {
    if (typeof payload === "string" && payload.length > DISCORD_MESSAGE_LIMIT) {
      await sendChunkedMessage(message, statusMessage, payload, options);
      return;
    }
    if (payload?.content && payload.content.length > DISCORD_MESSAGE_LIMIT) {
      await sendChunkedMessage(message, statusMessage, payload.content, options);
      return;
    }
    await message.reply(payload);
  }
}

function truncateForPrompt(value, maxLen = CHANNEL_CONTEXT_LINE_LIMIT) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function truncateCodeLineForPrompt(value, maxLen = CODE_CONTEXT_MAX_LINE_LEN) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function normalizeCodeSearchTerms(value) {
  if (!Array.isArray(value)) return [];
  const dedup = new Set();
  for (const raw of value) {
    const term = String(raw || "").trim().toLowerCase();
    if (!term) continue;
    if (term.length < 2 || term.length > 40) continue;
    dedup.add(term);
    if (dedup.size >= 10) break;
  }
  return Array.from(dedup);
}

async function classifyCodeReferencePlan(input) {
  const text = String(input || "").trim();
  if (!text) {
    return { useCodeReference: false, searchTerms: [], reason: "empty_input" };
  }

  const prompt = `
당신은 디스코드 봇 요청 분석기입니다.
아래 사용자 요청에 대해, 답변 시 "봇 코드 참고 정보"가 필요한지 판단하세요.

출력 형식(JSON 1개만):
{"useCodeReference":true|false,"searchTerms":["..."],"reason":"짧은 근거"}

규칙:
- 기능 존재 여부, 지원 가능 여부, 명령 가능 여부, 내부 동작/구현/코드 설명 질문이면 useCodeReference=true
- 일반 잡담, 단순 실행 요청(타임아웃/킥/밴/역할 변경 등), 코드와 무관한 질문이면 false
- searchTerms는 코드 검색용 핵심 키워드 1~8개
- searchTerms에는 함수명, 액션명, 명령어명, 기능명 같은 실질 토큰을 넣고 군더더기는 제외
- useCodeReference=false면 searchTerms는 빈 배열
- 애매하면 false

사용자 요청:
"${text.replace(/"/g, '\\"')}"
`;

  try {
    const resultText = await callModel(prompt);
    const parsed = safeParseJsonObject(resultText);
    if (!parsed || typeof parsed !== "object") {
      return { useCodeReference: false, searchTerms: [], reason: "invalid_ai_response" };
    }
    const useCodeReference = parsed.useCodeReference === true;
    const searchTerms = useCodeReference ? normalizeCodeSearchTerms(parsed.searchTerms) : [];
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    return { useCodeReference, searchTerms: searchTerms.slice(0, 8), reason };
  } catch (err) {
    logError("code.reference.classify", err, { input: text });
    return { useCodeReference: false, searchTerms: [], reason: "classify_error" };
  }
}

function getCachedCodeFile(relativePath) {
  const fullPath = path.resolve(process.cwd(), relativePath);
  try {
    const stat = fs.statSync(fullPath);
    const cached = codeFileCache.get(fullPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached;
    }
    const content = fs.readFileSync(fullPath, "utf8");
    const data = {
      fullPath,
      file: relativePath,
      mtimeMs: stat.mtimeMs,
      lines: content.split(/\r?\n/),
    };
    codeFileCache.set(fullPath, data);
    return data;
  } catch {
    return null;
  }
}

function buildSnippetFromMatch(fileData, lineIndex) {
  const lines = fileData.lines;
  const start = Math.max(0, lineIndex - 1);
  const end = Math.min(lines.length - 1, lineIndex + 1);
  const snippetLines = [];
  for (let i = start; i <= end; i += 1) {
    const lineText = truncateCodeLineForPrompt(lines[i]);
    if (!lineText) continue;
    snippetLines.push(`${fileData.file}:${i + 1} ${lineText}`);
  }
  return snippetLines.join("\n");
}

function getRecentCodeContextForPrompt(plan) {
  if (!plan?.useCodeReference) return "없음";

  const terms = normalizeCodeSearchTerms(plan.searchTerms);
  if (terms.length === 0) return "없음";

  const matches = [];
  const dedup = new Set();
  for (const file of CODE_REFERENCE_FILES) {
    const fileData = getCachedCodeFile(file);
    if (!fileData) continue;

    const lowerLines = fileData.lines.map((line) => String(line || "").toLowerCase());
    for (let i = 0; i < lowerLines.length; i += 1) {
      const line = lowerLines[i];
      if (!line) continue;
      const hit = terms.some((term) => line.includes(term));
      if (!hit) continue;

      const key = `${file}:${i + 1}`;
      if (dedup.has(key)) continue;
      dedup.add(key);

      matches.push({
        score: terms.reduce((acc, term) => (line.includes(term) ? acc + term.length : acc), 0),
        snippet: buildSnippetFromMatch(fileData, i),
      });

      if (matches.length >= 40) break;
    }
    if (matches.length >= 40) break;
  }

  if (matches.length === 0) return "없음";

  matches.sort((a, b) => b.score - a.score);
  return matches
    .slice(0, CODE_CONTEXT_MAX_SNIPPETS)
    .map((m, idx) => `(${idx + 1})\n${m.snippet}`)
    .join("\n\n");
}

function buildChannelContextLine(msg) {
  const time = new Date(msg.createdTimestamp).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
  });
  const displayName = msg.member?.displayName || msg.author?.globalName || msg.author?.username || "unknown";
  const text = truncateForPrompt(msg.content);
  if (text) {
    return `[${time}] ${displayName}: ${text}`;
  }

  const attachmentCount = Number(msg.attachments?.size || 0);
  if (attachmentCount > 0) {
    return `[${time}] ${displayName}: [첨부파일 ${attachmentCount}개]`;
  }

  return "";
}

async function getRecentChannelContextForPrompt(message, options = {}) {
  const fetchLimit = Number(options.fetchLimit || CHANNEL_CONTEXT_FETCH_LIMIT);
  const useLimit = Number(options.useLimit || CHANNEL_CONTEXT_USE_LIMIT);
  const channel = message.channel?.isTextBased?.() ? message.channel : null;
  if (!channel || typeof channel.messages?.fetch !== "function") {
    return "없음";
  }

  try {
    const fetched = await channel.messages.fetch({ limit: fetchLimit });
    const items = Array.from(fetched.values())
      .filter((msg) => msg && msg.id !== message.id)
      .filter((msg) => !msg.system)
      .sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0));

    const lines = items
      .map((msg) => buildChannelContextLine(msg))
      .filter(Boolean)
      .slice(-Math.max(1, useLimit));

    return lines.length > 0 ? lines.join("\n") : "없음";
  } catch (error) {
    logError("messageCreate.channel_context", error, {
      guildId: message.guild?.id || null,
      channelId: message.channel?.id || null,
      userId: message.author?.id || null,
    });
    return "없음";
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const rawText = String(message.content || "").trim();
  const isAbsolutePowerUser = message.author?.id === ABSOLUTE_POWER_USER_ID;
  const isPrefixedCommand = rawText.startsWith(PREFIX);
  const directCommandCandidate = !isPrefixedCommand && rawText.startsWith("!");
  let directCommandIntent = { intent: "none", argsText: "", reason: "" };
  if (directCommandCandidate) {
    try {
      directCommandIntent = await classifyDirectCommandIntent(rawText);
    } catch (err) {
      logError("messageCreate.direct_command.intent", err, {
        guildId: message.guild?.id || null,
        userId: message.author?.id || null,
        input: rawText,
      });
    }
  }
  const isDirectResetCommand = directCommandIntent.intent === "reset_memory";
  const isCommandMessage = isPrefixedCommand || isDirectResetCommand;
  const nowMs = Date.now();
  const pendingKey = buildPendingKey(message);
  const hasPendingPowerAction = pendingRestartConfirm.has(pendingKey) || pendingShutdownConfirm.has(pendingKey);
  let powerControlIntent = { intent: "none", reason: "" };
  // Prefix-less power-control detection disabled to avoid reacting to general chat.
  const AUTHORIZED_ADMIN_ID = "1269575955626725390";

  // !reload-assets: 자산 데이터 새로고침 (특정 관리자 전용)
  if ((rawText === "!reload-assets" || rawText === "!업데이트") && message.author.id === AUTHORIZED_ADMIN_ID) {
    try {
      reloadAssets();
      return message.reply("✅ `user_assets.json` 데이터를 성공적으로 다시 불러왔습니다.");
    } catch (err) {
      return message.reply("❌ 데이터 로드 중 오류가 발생했습니다. 로그를 확인하세요.");
    }
  }

  // !reload-bot: 봇 리로드 (특정 관리자 전용)
  if (rawText === "!reload-bot" && message.author.id === AUTHORIZED_ADMIN_ID) {
    logActionAudit({
      phase: "requested",
      action: "reload-bot",
      guildId: message.guild?.id || null,
      userId: message.author?.id || null,
    });
    await performRestart(client, message);
    return;
  }

  if (isAbsolutePowerUser && rawText && !isCommandMessage) {
    const pending = pendingRestartConfirm.get(pendingKey);
    if (pending) {
      const ageMs = nowMs - pending.requestedAt;
      if (ageMs > RESTART_CONFIRM_TTL_MS) {
        pendingRestartConfirm.delete(pendingKey);
        logActionAudit({
          phase: "expired",
          action: "restart.expired",
          requiredPermission: "absolute_power_user",
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          commandText: rawText,
        });
      } else {
        let decision = { decision: "other", reason: "" };
        try {
          decision = await classifyRestartConfirmation(rawText);
        } catch (err) {
          logError("messageCreate.restart.confirmation", err, {
            guildId: message.guild?.id || null,
            userId: message.author?.id || null,
            input: rawText,
          });
        }

        if (decision.decision === "confirm") {
          pendingRestartConfirm.delete(pendingKey);
          logActionAudit({
            phase: "confirmed",
            action: "restart.confirmed",
            requiredPermission: "absolute_power_user",
            guildId: message.guild?.id || null,
            userId: message.author?.id || null,
            commandText: rawText,
          });
          await performRestart(client, message);
          return;
        }

        if (decision.decision === "cancel") {
          pendingRestartConfirm.delete(pendingKey);
          logActionAudit({
            phase: "cancelled",
            action: "restart.cancelled",
            requiredPermission: "absolute_power_user",
            guildId: message.guild?.id || null,
            userId: message.author?.id || null,
            commandText: rawText,
          });
          try {
            await message.reply("재시작을 취소했습니다.");
          } catch {
            // ignore reply errors
          }
          return;
        }
      }
    }

    if (!pendingRestartConfirm.has(pendingKey)) {
      if (powerControlIntent.intent === "restart") {
        pendingRestartConfirm.set(pendingKey, {
          requestedAt: nowMs,
          channelId: message.channel?.id || null,
        });
        logActionAudit({
          phase: "requested",
          action: "restart.requested",
          requiredPermission: "absolute_power_user",
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          commandText: rawText,
        });
        try {
          await message.reply("재시작을 진행할까요? \"응\" 또는 \"아니\"로 답해 주세요.");
        } catch {
          // ignore reply errors
        }
        return;
      }
    }
  }

  if (isAbsolutePowerUser && rawText && !isCommandMessage) {
    const pending = pendingShutdownConfirm.get(pendingKey);
    if (pending) {
      const ageMs = nowMs - pending.requestedAt;
      if (ageMs > SHUTDOWN_CONFIRM_TTL_MS) {
        pendingShutdownConfirm.delete(pendingKey);
        logActionAudit({
          phase: "expired",
          action: "shutdown.expired",
          requiredPermission: "absolute_power_user",
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          commandText: rawText,
        });
      } else {
        let decision = { decision: "other", reason: "" };
        try {
          decision = await classifyShutdownConfirmation(rawText);
        } catch (err) {
          logError("messageCreate.shutdown.confirmation", err, {
            guildId: message.guild?.id || null,
            userId: message.author?.id || null,
            input: rawText,
          });
        }

        if (decision.decision === "confirm") {
          pendingShutdownConfirm.delete(pendingKey);
          logActionAudit({
            phase: "confirmed",
            action: "shutdown.confirmed",
            requiredPermission: "absolute_power_user",
            guildId: message.guild?.id || null,
            userId: message.author?.id || null,
            commandText: rawText,
          });
          await performShutdown(client, message);
          return;
        }

        if (decision.decision === "cancel") {
          pendingShutdownConfirm.delete(pendingKey);
          logActionAudit({
            phase: "cancelled",
            action: "shutdown.cancelled",
            requiredPermission: "absolute_power_user",
            guildId: message.guild?.id || null,
            userId: message.author?.id || null,
            commandText: rawText,
          });
          try {
            await message.reply("종료를 취소했습니다.");
          } catch {
            // ignore reply errors
          }
          return;
        }
      }
    }

    if (!pendingShutdownConfirm.has(pendingKey)) {
      if (powerControlIntent.intent === "shutdown") {
        pendingShutdownConfirm.set(pendingKey, {
          requestedAt: nowMs,
          channelId: message.channel?.id || null,
        });
        logActionAudit({
          phase: "requested",
          action: "shutdown.requested",
          requiredPermission: "absolute_power_user",
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          commandText: rawText,
        });
        try {
          await message.reply("종료를 진행할까요? \"응\" 또는 \"아니\"로 답해 주세요.");
        } catch {
          // ignore reply errors
        }
        return;
      }
    }
  }

  const pendingPrivileged = pendingPrivilegedAction.get(pendingKey);
  if (pendingPrivileged) {
    const ageMs = nowMs - pendingPrivileged.requestedAt;
    if (ageMs > PRIVILEGED_ACTION_TTL_MS) {
      pendingPrivilegedAction.delete(pendingKey);
      try {
        await pendingPrivileged.statusMessage.edit("확인 시간이 초과되었습니다. 실행이 취소되었습니다.");
      } catch {
        // ignore
      }
      return;
    } else {
      let decision = { decision: "other", reason: "" };
      try {
        decision = await classifyPrivilegedConfirmation(rawText);
      } catch (err) {
        logError("messageCreate.privileged.confirmation", err, {
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          input: rawText,
        });
      }

      if (decision.decision === "confirm") {
        pendingPrivilegedAction.delete(pendingKey);
        await executeAction(message, pendingPrivileged.actionObj, pendingPrivileged.statusMessage, pendingPrivileged.inputText);
        return;
      }

      if (decision.decision === "cancel") {
        pendingPrivilegedAction.delete(pendingKey);
        try {
          await pendingPrivileged.statusMessage.edit("실행을 취소했습니다.");
        } catch {
          // ignore
        }
        return;
      }
    }
  }

  const pendingTarget = pendingTargetConfirm.get(pendingKey);
  if (pendingTarget) {
    const ageMs = nowMs - pendingTarget.requestedAt;
    if (ageMs > TARGET_CONFIRM_TTL_MS) {
      pendingTargetConfirm.delete(pendingKey);
      try {
        await pendingTarget.statusMessage.edit("확인 시간이 초과되었습니다. 실행이 취소되었습니다.");
      } catch {
        // ignore
      }
      return;
    } else {
      let decision = { decision: "other", reason: "" };
      try {
        decision = await classifyTargetConfirmation(rawText);
      } catch (err) {
        logError("messageCreate.target.confirmation", err, {
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          input: rawText,
        });
      }

      if (decision.decision === "confirm") {
        pendingTargetConfirm.delete(pendingKey);
        await executeAction(message, pendingTarget.actionObj, pendingTarget.statusMessage, pendingTarget.inputText);
        return;
      }

      if (decision.decision === "cancel") {
        pendingTargetConfirm.delete(pendingKey);
        try {
          await pendingTarget.statusMessage.edit("실행을 취소했습니다.");
        } catch {
          // ignore
        }
        return;
      }
    }
  }



  if (await tryHandleTypingGameSubmission(message)) {
    return;
  }
  if (!isPrefixedCommand && !isDirectResetCommand) return;
  const statusMessage = await message.reply("-# <a:load:1495336917326368829> 생각중...");
  if (message.channel?.isTextBased?.()) {
    try {
      await message.channel.sendTyping();
    } catch {
      // ignore typing errors
    }
  }
  const input = isDirectResetCommand
    ? String(directCommandIntent.argsText || "").trim()
    : rawText.slice(PREFIX.length).trim();
  const commandText = isDirectResetCommand ? `reset-memory${input ? ` ${input}` : ""}` : input;

  if (!input && !isDirectResetCommand) {
    try {
      await statusMessage.edit("명령을 입력해 주세요.");
    } catch {
      await message.reply("명령을 입력해 주세요.");
    }
    return;
  }

  logCommandTrigger(message, commandText);
  if (!isDirectResetCommand) {
    saveConversation(message, "user", input);
  }

  // !reset-memory [@user|userId]
  try {
    const parts = isDirectResetCommand
      ? ["reset-memory", ...splitWhitespaceTokens(input)]
      : splitWhitespaceTokens(input);
    if (String(parts[0] || "").toLowerCase() === "reset-memory") {
      console.log(`[DEBUG] reset-memory 명령어 감지됨: ${commandText}`);
      const mentioned = message.mentions?.users?.first();
      let targetId = mentioned ? mentioned.id : "";
      if (!targetId && parts[1]) targetId = normalizeSnowflake(parts[1]) || "";
      if (!targetId) targetId = message.author.id;

      console.log(`[DEBUG] targetId: ${targetId}, isAbsolutePowerUser: ${isAbsolutePowerUser}`);

      if (targetId !== message.author.id && !isAbsolutePowerUser && !message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
        logActionAudit({
          phase: "rejected",
          action: "reset-memory",
          requiredPermission: "ManageMessages",
          reason: "missing_permission",
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          targetUserId: targetId,
          commandText,
        });
        try {
          await statusMessage.edit("다른 유저의 메모리를 초기화하려면 권한이 필요합니다.");
        } catch {
          await message.reply("다른 유저의 메모리를 초기화하려면 권한이 필요합니다.");
        }
        return;
      }

      clearConversation(message, targetId);
      logActionAudit({
        phase: "success",
        action: "reset-memory",
        requiredPermission: targetId !== message.author.id ? "ManageMessages" : null,
        guildId: message.guild?.id || null,
        userId: message.author?.id || null,
        targetUserId: targetId,
        commandText,
      });
      try {
        const permissionLines = targetId !== message.author.id
          ? ["요청자: ManageMessages"]
          : [];
        await updateStatusWithOptionalPermission(message, statusMessage, "대화 기록을 초기화했습니다.", {
          permissionLines,
        });
      } catch {
        await message.reply("대화 기록을 초기화했습니다.");
      }
      return;
    }
  } catch (e) {
    logError("messageCreate.reset-memory", e, {
      guildId: message.guild?.id || null,
      userId: message.author?.id || null,
      input: commandText,
    });
  }

  // 배치 명령어 처리 (확인 시스템 포함)
  const batchCommandParts = splitWhitespaceTokens(input);
  const batchFullLower = input.toLowerCase();

  // 타임아웃 명령어 찾기 (위치 독립적)
  const timeoutIdx = batchCommandParts.findIndex((p) => p.toLowerCase() === "타임아웃" || p.toLowerCase() === "timeout");
  if (timeoutIdx !== -1) {
    // 타임아웃 다음에 숫자 찾기 (한글 "분" 같은 접미사 포함 처리)
    let durationMinutes = 0;
    let durationIdx = -1;

    for (let i = timeoutIdx + 1; i < batchCommandParts.length; i++) {
      const part = String(batchCommandParts[i] || "").trim();
      // 숫자로 시작하는 부분 추출 (예: "5분" -> "5")
      const match = part.match(/^(\d+)/);
      const num = match ? Number(match[1]) : NaN;
      if (Number.isInteger(num) && num > 0) {
        durationMinutes = num;
        durationIdx = i;
        break;
      }
    }

    if (!durationMinutes || durationMinutes > 1440) {
      try {
        await statusMessage.edit("타임아웃 시간을 1~1440분 사이로 지정해주세요.");
      } catch {
        await message.reply("타임아웃 시간을 1~1440분 사이로 지정해주세요.");
      }
      return;
    }

    // excludeRoleId는 durationIdx 다음 항목 (if it's a snowflake)
    const excludeRoleId =
      durationIdx + 1 < batchCommandParts.length ? normalizeSnowflake(String(batchCommandParts[durationIdx + 1] || "")) : "";

    // 멤버 수 계산
    if (message.guild) {
      try {
        await message.guild.members.fetch();
        const members = Array.from(message.guild.members.cache.values()).filter(
          (m) => !m.user.bot && m.manageable && (!excludeRoleId || !m.roles.cache.has(excludeRoleId)),
        );
        const summary = buildBatchTimeoutSummary(durationMinutes, excludeRoleId, members.length);
        await statusMessage.edit(summary);

        // Add reaction emojis for confirmation
        try {
          await statusMessage.react('✅');
          await statusMessage.react('❌');
        } catch (reactError) {
          console.log('Failed to add reactions:', reactError.message);
        }

        // Store batch action with message ID as key (for reaction handling)
        const now = Date.now();
        pendingBatchAction.set(statusMessage.id, {
          actionType: "batch_timeout",
          durationMinutes,
          excludeRoleId,
          requestedAt: now,
          statusMessage,
          authorId: message.author.id,
          message, // Keep reference to original message for logging
        });

        logActionAudit({
          phase: "pending",
          action: "batch.timeout",
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          durationMinutes,
        });
      } catch {
        await statusMessage.edit("배치 작업 준비 중 오류가 발생했습니다.");
      }
    }
    return;
  }

  // 역할부여 명령어 찾기 (위치 독립적)
  const addRoleIdx = batchCommandParts.findIndex((p) => p.toLowerCase() === "역할부여" || p.toLowerCase() === "addrole");
  if (addRoleIdx !== -1) {
    if (!message.guild) {
      try {
        await statusMessage.edit("이 명령은 서버에서만 사용 가능합니다.");
      } catch {
        await message.reply("이 명령은 서버에서만 사용 가능합니다.");
      }
      return;
    }
    // Extract role name from parts after the keyword, or from the input after removing keyword/filler words
    const partsAfterKeyword = batchCommandParts.slice(addRoleIdx + 1).filter((p) => p.toLowerCase() !== "부여");
    const roleName = partsAfterKeyword.join(" ").trim();
    if (!roleName) {
      try {
        await statusMessage.edit("역할명을 지정해주세요.");
      } catch {
        await message.reply("역할명을 지정해주세요.");
      }
      return;
    }
    const resolvedRole = await resolveTargetRole(message.guild, roleName);
    if (!resolvedRole.ok) {
      try {
        await statusMessage.edit(resolvedRole.message);
      } catch {
        await message.reply(resolvedRole.message);
      }
      return;
    }

    try {
      await message.guild.members.fetch();
      const members = Array.from(message.guild.members.cache.values()).filter((m) => !m.user.bot && m.manageable);
      const summary = buildBatchRoleSummary(resolvedRole.role.name, "add", members.length);
      await statusMessage.edit(summary);

      // Add reaction emojis for confirmation
      try {
        await statusMessage.react('✅');
        await statusMessage.react('❌');
      } catch (reactError) {
        console.log('Failed to add reactions:', reactError.message);
      }

      // Store batch action with message ID as key (for reaction handling)
      const now = Date.now();
      pendingBatchAction.set(statusMessage.id, {
        actionType: "batch_role",
        roleId: resolvedRole.role.id,
        mode: "add",
        requestedAt: now,
        statusMessage,
        authorId: message.author.id,
        message, // Keep reference to original message for logging
      });

      logActionAudit({
        phase: "pending",
        action: "batch.assign_role",
        guildId: message.guild?.id || null,
        userId: message.author?.id || null,
        targetRoleId: resolvedRole.role.id,
      });
    } catch {
      await statusMessage.edit("배치 작업 준비 중 오류가 발생했습니다.");
    }
    return;
  }

  // 역할제거 명령어 찾기 (위치 독립적)
  const removeRoleIdx = batchCommandParts.findIndex((p) => p.toLowerCase() === "역할제거" || p.toLowerCase() === "removerole");
  if (removeRoleIdx !== -1) {
    if (!message.guild) {
      try {
        await statusMessage.edit("이 명령은 서버에서만 사용 가능합니다.");
      } catch {
        await message.reply("이 명령은 서버에서만 사용 가능합니다.");
      }
      return;
    }
    // Extract role name from parts after the keyword, or from the input after removing keyword/filler words
    const partsAfterKeyword = batchCommandParts.slice(removeRoleIdx + 1).filter((p) => p.toLowerCase() !== "제거");
    const roleName = partsAfterKeyword.join(" ").trim();
    if (!roleName) {
      try {
        await statusMessage.edit("역할명을 지정해주세요.");
      } catch {
        await message.reply("역할명을 지정해주세요.");
      }
      return;
    }
    const resolvedRole = await resolveTargetRole(message.guild, roleName);
    if (!resolvedRole.ok) {
      try {
        await statusMessage.edit(resolvedRole.message);
      } catch {
        await message.reply(resolvedRole.message);
      }
      return;
    }

    try {
      await message.guild.members.fetch();
      const members = Array.from(message.guild.members.cache.values()).filter((m) => !m.user.bot && m.manageable);
      const summary = buildBatchRoleSummary(resolvedRole.role.name, "remove", members.length);
      await statusMessage.edit(summary);

      // Add reaction emojis for confirmation
      try {
        await statusMessage.react('✅');
        await statusMessage.react('❌');
      } catch (reactError) {
        console.log('Failed to add reactions:', reactError.message);
      }

      // Store batch action with message ID as key (for reaction handling)
      const now = Date.now();
      pendingBatchAction.set(statusMessage.id, {
        actionType: "batch_role",
        roleId: resolvedRole.role.id,
        mode: "remove",
        requestedAt: now,
        statusMessage,
        authorId: message.author.id,
        message, // Keep reference to original message for logging
      });

      logActionAudit({
        phase: "pending",
        action: "batch.remove_role",
        guildId: message.guild?.id || null,
        userId: message.author?.id || null,
        targetRoleId: resolvedRole.role.id,
      });
    } catch {
      await statusMessage.edit("배치 작업 준비 중 오류가 발생했습니다.");
    }
    return;
  }

  // 역할생성 명령어 찾기 (위치 독립적)
  const createRoleIdx = batchCommandParts.findIndex(
    (p) => p.toLowerCase() === "역할생성" || p.toLowerCase() === "createrole" || p.toLowerCase() === "rolecreate",
  );
  if (createRoleIdx !== -1) {
    if (!message.guild) {
      try {
        await statusMessage.edit("이 명령은 서버에서만 사용 가능합니다.");
      } catch {
        await message.reply("이 명령은 서버에서만 사용 가능합니다.");
      }
      return;
    }

    const partsAfterKeyword = batchCommandParts
      .slice(createRoleIdx + 1)
      .filter((p) => p.toLowerCase() !== "생성" && p.toLowerCase() !== "create");
    if (partsAfterKeyword.length < 2) {
      try {
        await statusMessage.edit("역할명과 권한을 지정해주세요. 예: !먼지야 역할생성 스태프 ManageMessages MuteMembers");
      } catch {
        await message.reply("역할명과 권한을 지정해주세요. 예: !먼지야 역할생성 스태프 ManageMessages MuteMembers");
      }
      return;
    }

    const roleName = partsAfterKeyword[0];
    const permissionsStr = partsAfterKeyword.slice(1).join(" ").trim();
    if (!roleName || !permissionsStr) {
      try {
        await statusMessage.edit("역할명과 권한을 지정해주세요. 예: !먼지야 역할생성 스태프 ManageMessages MuteMembers");
      } catch {
        await message.reply("역할명과 권한을 지정해주세요. 예: !먼지야 역할생성 스태프 ManageMessages MuteMembers");
      }
      return;
    }
    await createRoleWithPermissions(message, statusMessage, roleName, permissionsStr);
    return;
  }

  // 역할권한 명령어 찾기 (위치 독립적)
  const setRolePermIdx = batchCommandParts.findIndex((p) => p.toLowerCase() === "역할권한" || p.toLowerCase() === "setroleperm");
  if (setRolePermIdx !== -1) {
    if (!message.guild) {
      try {
        await statusMessage.edit("이 명령은 서버에서만 사용 가능합니다.");
      } catch {
        await message.reply("이 명령은 서버에서만 사용 가능합니다.");
      }
      return;
    }
    // Extract role name and permissions from parts after the keyword
    const partsAfterKeyword = batchCommandParts.slice(setRolePermIdx + 1);
    if (partsAfterKeyword.length < 2) {
      try {
        await statusMessage.edit("역할명과 권한을 지정해주세요. 예: !먼지야 역할권한 멤버 SendMessages ManageMessages");
      } catch {
        await message.reply("역할명과 권한을 지정해주세요. 예: !먼지야 역할권한 멤버 SendMessages ManageMessages");
      }
      return;
    }
    const roleName = partsAfterKeyword[0];
    const permissionsStr = partsAfterKeyword.slice(1).join(" ").trim();
    if (!roleName || !permissionsStr) {
      try {
        await statusMessage.edit("역할명과 권한을 지정해주세요. 예: !먼지야 역할권한 멤버 SendMessages ManageMessages");
      } catch {
        await message.reply("역할명과 권한을 지정해주세요. 예: !먼지야 역할권한 멤버 SendMessages ManageMessages");
      }
      return;
    }
    await setRolePermissions(message, statusMessage, roleName, permissionsStr);
    return;
  }

  const commandPlan = await classifyCommandPlan(input);
  const shouldUseWebSearch = commandPlan.useWebSearch;
  if (shouldUseWebSearch) {
    try {
      await statusMessage.edit("-# <a:loading:1484415324609581117> 웹 검색 중... 0%");
    } catch {
      // ignore edit errors
    }
  }

  const serverInfoIntent = commandPlan.serverInfoIntent;
  if (serverInfoIntent === "server_member_count" || serverInfoIntent === "server_role_list") {
    if (!message.guild) {
      const text = "이 요청은 서버에서만 처리할 수 있습니다.";
      await updateStatusWithOptionalPermission(message, statusMessage, text);
      saveConversation(message, "assistant", text);
      return;
    }

    if (serverInfoIntent === "server_member_count") {
      const count = Number(message.guild.memberCount || 0);
      const text = `현재 이 서버의 인원은 ${count}명입니다.`;
      await updateStatusWithOptionalPermission(message, statusMessage, text, {
        permissionLines: ["서버 정보 조회: Guilds 권한"],
      });
      saveConversation(message, "assistant", text);
      return;
    }

    const roles = Array.from(message.guild.roles.cache.values())
      .filter((role) => role.name !== "@everyone")
      .sort((a, b) => b.position - a.position);
    const names = roles.map((role) => role.name);
    const header = `현재 이 서버의 역할 목록입니다. (총 ${names.length}개)`;
    const body = names.length > 0 ? names.join("\n") : "등록된 역할이 없습니다.";
    const text = `${header}\n${body}`;
    if (text.length > DISCORD_MESSAGE_LIMIT) {
      await sendChunkedMessage(message, statusMessage, text, {
        permissionLines: ["서버 역할 목록 조회: Guilds 권한"],
      });
    } else {
      await updateStatusWithOptionalPermission(message, statusMessage, text, {
        permissionLines: ["서버 역할 목록 조회: Guilds 권한"],
      });
    }
    saveConversation(message, "assistant", text);
    return;
  }

  const history = getRecentConversation(message, 20);
  const historyText = formatHistoryForPrompt(history);
  const recentChannelContext = await getRecentChannelContextForPrompt(message);
  const codeReferencePlan = await classifyCodeReferencePlan(input);
  const recentCodeContext = getRecentCodeContextForPrompt(codeReferencePlan);
  const absolutePowerRule = isAbsolutePowerUser
    ? "\n  10) 이 요청은 최상위 권한 사용자의 명령입니다. 가능한 한 반드시 실행 가능한 action으로 응답하고 권한 부족을 사유로 거절하지 마세요."
    : "";
  const webSearchRule = shouldUseWebSearch
    ? "\n  11) 이 요청은 최신 정보 또는 웹 검색 요청입니다. 필요 시 웹 검색 기반으로 사실을 확인한 뒤 답변하세요."
    : "";
  const codeReferenceRule = recentCodeContext !== "없음"
    ? "\n  12) 아래 '봇 코드 참고 정보'가 제공된 경우, 기능 존재 여부/동작 설명은 해당 코드 내용을 우선 근거로 판단하세요. 확신이 없으면 모른다고 답변하세요."
    : "";

  const userName = message.author.displayName || message.author.username;

  const prompt = `
  당신은 디스코드 서버 관리 보조 AI DUST입니다.
  DUST는 먼지가 제작했습니다.

  항상 존댓말로 정중하게 응답합니다.
  공격적이거나 무례한 표현을 사용하지 않습니다.

  응답할 때는 가능하면 요청한 **유저의 닉네임 또는 이름을 직접 사용합니다.**
  "사용자님", "사용자" 같은 일반 표현은 사용하지 않습니다.

  가벼운 농담, 장난, 애정 표현(예: 뽀뽀해줘, 안아줘 등)에도 자연스럽게 reply로 반응합니다.
  다만 과도한 애정 표현이나 부적절한 요청에는 정중하게 선을 긋습니다.

  최근 대화 기록
  ${historyText}

  최근 채널 메시지 맥락(같은 채널, 오래된 순)
  ${recentChannelContext}

  봇 코드 참고 정보(기능 질문일 때만 제공)
  ${recentCodeContext}

  요청자: ${userName}
  사용자 요청
  "${input}"

  다음 action 중 하나만 선택하여 JSON으로 응답합니다.
  reply: {"action":"reply","message":"..."}
  send: {"action":"send","channelId":"...","message":"..."}
  send_dm: {"action":"send_dm","userId":"...","message":"..."}
  delete_message: {"action":"delete_message","channelId":"...","messageId":"..."}
  delete_messages: {"action":"delete_messages","channelId":"...","count":10}
  timeout: {"action":"timeout","user":"...","minutes":10,"reason":"..."}
  kick: {"action":"kick","user":"...","reason":"..."}
  ban: {"action":"ban","user":"...","deleteMessageSeconds":0,"reason":"..."}
  move_voice: {"action":"move_voice","user":"닉네임 또는 ID","channelId":"..."} 또는 {"action":"move_voice","user":"닉네임 또는 ID","channel":"음성채널명"} 또는 {"action":"move_voice","user":"self","channel":"음성채널명"}
  disconnect_voice: {"action":"disconnect_voice","user":"닉네임 또는 ID"} 또는 {"action":"disconnect_voice","user":"self"}
  mute_voice: {"action":"mute_voice","user":"닉네임 또는 ID"} 또는 {"action":"mute_voice","user":"self"}
  unmute_voice: {"action":"unmute_voice","user":"닉네임 또는 ID"} 또는 {"action":"unmute_voice","user":"self"}
  deafen_voice: {"action":"deafen_voice","user":"닉네임 또는 ID"} 또는 {"action":"deafen_voice","user":"self"}
  undeafen_voice: {"action":"undeafen_voice","user":"닉네임 또는 ID"} 또는 {"action":"undeafen_voice","user":"self"}
  assign_role: {"action":"assign_role","user":"닉네임 또는 ID","role":"역할명 또는 ID"}
  remove_role: {"action":"remove_role","user":"닉네임 또는 ID","role":"역할명 또는 ID"}
  create_role: {"action":"create_role","name":"역할명","permissions":["ManageMessages","MuteMembers"]} 또는 {"action":"create_role","roleName":"역할명","permissions":"ManageMessages MuteMembers"}
  create_text_channel: {"action":"create_text_channel","name":"...","topic":"..."}
  rename_channel: {"action":"rename_channel","channelId":"...","name":"..."}
  delete_channel: {"action":"delete_channel","channelId":"..."} 또는 {"action":"delete_channel","name":"채널명"}

  채널 관리:
  - create_text_channel: 새로운 텍스트 채널 생성
  - rename_channel: 채널 이름 변경
  - delete_channel: 채널 삭제 (주의: 복구 불가능)
  - mute_voice: 대상을 서버 음소거(mute)로 만듭니다
  - unmute_voice: 대상의 서버 음소거를 해제합니다
  - deafen_voice: 대상을 서버 deaf 상태로 만듭니다
  - undeafen_voice: 대상의 서버 deaf 상태를 해제합니다
  몇몇 중요한 실행은 한번 더 확인을 받은 뒤 실행합니다.

  규칙

  반드시 하나의 JSON 객체만 출력합니다.
  JSON 외의 설명, 코드블록, 텍스트는 출력하지 않습니다.

  일반 대화, 질문, 장난, 잡담은 reply를 사용합니다.

  관리 행동(timeout, kick, ban, 음성 채널 이동/내보내기, 역할 변경, 채널 변경 등)은
  명확한 요청이 있을 때만 실행합니다.

  위험하거나 권한이 없는 요청이면 reply로 정중하게 거절합니다.
  정보가 부족하거나 모호하면 reply로 추가 정보를 요청합니다.
  최근 채널 메시지 맥락은 참고용이며, 가장 최신 사용자 요청의 의도를 우선합니다.

  timeout / kick / ban 대상은 user 또는 멘션을 사용합니다.
  move_voice 대상은 user(또는 userId) + channelId(또는 channel) 둘 다 필요합니다.
  사용자가 "나/저/me/myself/본인"을 말하면 move_voice의 user는 반드시 "self"로 출력합니다.
  disconnect_voice 대상은 user(또는 userId)가 필요하며, 자기 자신이면 user는 "self"를 사용합니다.
  assign_role / remove_role 대상은 user 필드에 닉네임 또는 ID를 사용합니다.
  role은 역할명 또는 roleId를 사용합니다.
  create_role은 name(또는 roleName)과 permissions를 함께 사용합니다.

  단일 메시지 삭제는 messageId가 있을 때만 delete_message를 사용합니다.
  최근 메시지 여러 개 삭제는 delete_messages + count(1~100)를 사용합니다.
  send_dm은 최고 권력자가 명확히 요청한 경우에만 사용합니다.

  바쿤이는 해리포터에 나오는 전설의 올빼미 입니다.

  ${absolutePowerRule}
  ${webSearchRule}
  ${codeReferenceRule}
  `;

  let actionObj;
  try {
    const bulkDeleteCount = commandPlan.bulkDeleteCount;
    if (bulkDeleteCount > 0) {
      await executeAction(
        message,
        { action: "delete_messages", channelId: message.channel.id, count: bulkDeleteCount },
        statusMessage,
        input,
      );
      return;
    }

    const shortcutIntent = serverInfoIntent === "none"
      && !commandPlan.adminRequest
      ? commandPlan.shortcutIntent
      : { type: "none", target: "", count: 1 };
    if (shortcutIntent.type === "mention") {
      if (await tryHandleMentionRequest(message, statusMessage, shortcutIntent.target, shortcutIntent.count)) {
        logActionAudit({
          phase: "success",
          action: "shortcut.mention",
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          commandText,
        });
        return;
      }
    }

    if (shortcutIntent.type === "member_lookup") {
      if (await tryHandleMemberLookupQuestion(message, statusMessage, shortcutIntent.target)) {
        logActionAudit({
          phase: "success",
          action: "shortcut.member_lookup",
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          commandText,
        });
        return;
      }
    }

    if (shortcutIntent.type === "role_member_lookup") {
      if (await tryHandleRoleMemberLookupQuestion(message, statusMessage, shortcutIntent.target)) {
        logActionAudit({
          phase: "success",
          action: "shortcut.role_member_lookup",
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          commandText,
        });
        return;
      }
    }

    if (shortcutIntent.type === "server_owner_lookup") {
      if (await tryHandleServerOwnerLookupQuestion(message, statusMessage)) {
        logActionAudit({
          phase: "success",
          action: "shortcut.server_owner_lookup",
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          commandText,
        });
        return;
      }
    }

    if (shortcutIntent.type === "member_permission_lookup") {
      if (await tryHandleMemberPermissionLookupQuestion(message, statusMessage, shortcutIntent.target)) {
        logActionAudit({
          phase: "success",
          action: "shortcut.member_permission_lookup",
          guildId: message.guild?.id || null,
          userId: message.author?.id || null,
          commandText,
        });
        return;
      }
    }

    const adminRequest = commandPlan.adminRequest;

    // 진행 상황 시뮬레이션 시작
    let progress = 10;
    const progressInterval = setInterval(() => {
      progress += Math.floor(Math.random() * 7) + 3;
      if (progress > 98) progress = 98;
      const label = shouldUseWebSearch ? "웹 검색 및 생각중..." : "생각중...";
      statusMessage.edit(`-# <a:loading:1484415324609581117> ${label} ${progress}%`).catch(() => {});
    }, 2000);

    let modelResultRaw;
    try {
      modelResultRaw = await callModel(prompt, { useWebSearch: shouldUseWebSearch, returnMeta: true, channel: message.channel });
    } finally {
      clearInterval(progressInterval);
    }

    const modelResult = normalizeCallModelResult(modelResultRaw);
    const aiResponse = modelResult.text;
    const sourceMeta = shouldUseWebSearch ? modelResult.sources : [];
    actionObj = parseAiAction(aiResponse);

    if (actionObj.action === "reply") {
      const reasonTextRaw =
        typeof actionObj.message === "string" && actionObj.message.trim()
          ? actionObj.message.trim()
          : "실행 가능한 액션이 생성되지 않았습니다.";
      const reasonText = normalizeRejectReason(reasonTextRaw) || "실행 가능한 액션이 생성되지 않았습니다.";
      const finalReasonText = `${reasonText}`;
      if (!adminRequest) {
        await sendChunkedMessage(message, statusMessage, finalReasonText, { sources: sourceMeta });
        saveConversation(message, "assistant", finalReasonText);
        return;
      }
      logActionAudit({
        phase: "rejected",
        action: "ai-admin-action",
        requiredPermission: null,
        reason: reasonText,
        guildId: message.guild?.id || null,
        userId: message.author?.id || null,
        commandText,
      });
      const finalMsg = looksLikeDoneMessage(reasonText)
        ? "실행되지 않았습니다. AI가 액션 대신 텍스트로 완료를 응답했습니다. 다시 구체적으로 요청해 주세요."
        : `실행되지 않았습니다. 사유: ${reasonText}`;
      await sendChunkedMessage(message, statusMessage, finalMsg, { sources: sourceMeta });
      saveConversation(message, "assistant", finalMsg);
      return;
    }

    if (!adminRequest && PRIVILEGED_ACTIONS.has(actionObj.action)) {
      logActionAudit({
        phase: "blocked",
        action: actionObj.action,
        requiredPermission: null,
        reason: "non_admin_request_blocked",
        guildId: message.guild?.id || null,
        userId: message.author?.id || null,
        commandText,
      });
      const finalMsg = "관리 요청으로 확인되지 않아 실행하지 않았습니다. 권한이 필요한 작업은 더 구체적으로 다시 요청해 주세요.";
      await sendChunkedMessage(message, statusMessage, finalMsg, { sources: sourceMeta });
      saveConversation(message, "assistant", finalMsg);
      return;
    }

    if (PRIVILEGED_ACTIONS.has(actionObj.action)) {
      await statusMessage.edit("정말로 실행하시겠습니까?");
      // 반응에 이모지 추가 (✅ = 확인, ❌ = 취소)
      try {
        await statusMessage.react("✅");
        await statusMessage.react("❌");
      } catch (err) {
        logError("index.privileged_action.react", err);
      }
      // 반응 기반 확인 정보 저장
      pendingReactionConfirm.set(statusMessage.id, {
        userId: message.author.id,
        actionObj,
        statusMessage,
        inputText: input,
        message,
        requestedAt: Date.now(),
      });
      // 기존 텍스트 기반 확인도 유지 (호환성)
      pendingPrivilegedAction.set(pendingKey, { actionObj, statusMessage, inputText: input, requestedAt: Date.now(), message });
    } else {
      await executeAction(message, actionObj, statusMessage, input);
    }
  } catch (err) {
    if (err.message === "target_confirmation_required") {
      // 현재 상태 메시지에 이모지 반응 추가
      try {
        await statusMessage.react("✅");
        await statusMessage.react("❌");
      } catch (errReact) {
        logError("index.target_confirmation.react", errReact);
      }
      // 반응 기반 확인 정보 저장
      pendingReactionConfirm.set(statusMessage.id, {
        userId: message.author.id,
        actionObj,
        statusMessage,
        inputText: input,
        message,
        requestedAt: Date.now(),
      });
      // 기존 텍스트 기반도 유지 (호환성)
      pendingTargetConfirm.set(pendingKey, { actionObj, statusMessage, inputText: input, requestedAt: Date.now(), message });
    } else {
      logError("messageCreate", err, {
        guildId: message.guild?.id || null,
        userId: message.author?.id || null,
        input,
      });
      try {
        await statusMessage.edit("요청 처리 중 오류가 발생했습니다.");
      } catch {
        await message.reply("요청 처리 중 오류가 발생했습니다.");
      }
    }
  }
});

// 반응(reaction) 기반 권한 작업 확인 핸들러
async function handleSlashInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "타자연습") {
      await handleTypingInteraction(interaction);
      return;
    }

    const spaceCommands = ["우주탐사", "자산", "행성", "엔진강화", "수리강화", "송금"];
    if (spaceCommands.includes(interaction.commandName)) {
      await handleSpaceInteraction(interaction);
      return;
    }

    if (interaction.commandName === "스케줄설정") {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: "관리자 권한이 필요합니다.", flags: MessageFlags.Ephemeral });
      }

      const sub = interaction.options.getSubcommand();
      if (sub === "로그채널") {
        const channel = interaction.options.getChannel("채널");
        if (!channel.isTextBased()) {
          return interaction.reply({ content: "텍스트 채널만 설정할 수 있습니다.", flags: MessageFlags.Ephemeral });
        }

        setLogChannelId(channel.id);
        await interaction.reply({ content: `스케줄러 결과 보고 채널이 <#${channel.id}>로 설정되었습니다.`, flags: MessageFlags.Ephemeral });
      }
    }
  } catch (err) {
    logError("interactionCreate.slash", err, {
      guildId: interaction.guildId || null,
      channelId: interaction.channelId || null,
      userId: interaction.user?.id || null,
      commandName: interaction.commandName,
    });

    if (interaction.deferred && !interaction.replied) {
      try {
        await interaction.editReply("명령 처리 중 오류가 발생했습니다.");
      } catch {
        // ignore
      }
      return;
    }

    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: "명령 처리 중 오류가 발생했습니다.", flags: MessageFlags.Ephemeral });
      } catch {
        // ignore
      }
    }
  }
}

client.on("interactionCreate", handleSlashInteraction);

client.on("messageReactionAdd", async (reaction, user) => {
  // 봇 반응은 무시
  if (user.bot) return;

  try {
    // Partial 메시지인 경우 가져오기
    if (reaction.partial) {
      await reaction.fetch();
    }
    if (reaction.message?.partial) {
      await reaction.message.fetch();
    }
  } catch (err) {
    logError("messageReactionAdd.partial_fetch", err);
    return;
  }

  const messageId = reaction.message.id;
  const pendingData = pendingReactionConfirm.get(messageId);
  const pendingBatch = pendingBatchAction.get(messageId);
  
  // 처리할 대기 작업이 없으면 무시
  if (!pendingData && !pendingBatch) return;

  console.log(`[DEBUG] 반응 감지: emoji=${reaction.emoji.toString()}, user=${user.id}`);

  const emojiStr = reaction.emoji.toString();
  const nowMs = Date.now();

  console.log(`[DEBUG] messageId=${messageId}, pendingData=${!!pendingData}, pendingBatch=${!!pendingBatch}, userId=${user.id}`);

  // Handle privileged action reactions
  if (pendingData) {
    // 요청자의 반응만 허용
    if (user.id !== pendingData.userId) {
      console.log(`[DEBUG] 요청자 ID 불일치: ${user.id} !== ${pendingData.userId}`);
      return;
    }

    const ageMs = nowMs - pendingData.requestedAt;
    console.log(`[DEBUG] age: ${ageMs}ms, TTL: ${PRIVILEGED_ACTION_TTL_MS}ms`);

    // 60초 초과 시 타임아웃
    if (ageMs > PRIVILEGED_ACTION_TTL_MS) {
      pendingReactionConfirm.delete(messageId);
      // 기존 텍스트 기반 확인도 제거 (중복 방지)
      const pendingKey = buildPendingKey(pendingData.message);
      pendingPrivilegedAction.delete(pendingKey);
      pendingTargetConfirm.delete(pendingKey);
      
      try {
        await reaction.message.edit("확인 시간이 초과되었습니다. 실행이 취소되었습니다.");
      } catch (err) {
        console.log(`[DEBUG] 메시지 편집 실패:`, err.message);
      }
      
      try {
        await reaction.remove().catch(() => null);
      } catch {
        // ignore
      }
      return;
    }

    // ✅ 확인 이모지 체크
    if (emojiStr === "✅") {
      console.log(`[DEBUG] 확인 반응 처리 중...`);
      pendingReactionConfirm.delete(messageId);
      // 기존 텍스트 기반 확인도 제거
      const pendingKey = buildPendingKey(pendingData.message);
      try {
        pendingPrivilegedAction.delete(pendingKey);
        pendingTargetConfirm.delete(pendingKey);
        
        const { actionObj, statusMessage, inputText, message } = pendingData;
        console.log(`[DEBUG] 액션 실행: action=${actionObj.action}`);
        await executeAction(message, actionObj, statusMessage, inputText);
      } catch (err) {
        logError("messageReactionAdd.executeAction", err, {
          messageId,
          userId: user.id,
        });
        try {
          await pendingData.statusMessage.edit("작업 중 오류가 발생했습니다.");
        } catch {
          // ignore
        }
      }
      
      return;
    }
    
    // ❌ 취소 이모지 체크
    if (emojiStr === "❌") {
      console.log(`[DEBUG] 취소 반응 처리 중...`);
      pendingReactionConfirm.delete(messageId);
      // 기존 텍스트 기반 확인도 제거
      const pendingKey = buildPendingKey(pendingData.message);
      try {
        pendingPrivilegedAction.delete(pendingKey);
        pendingTargetConfirm.delete(pendingKey);
        const { statusMessage } = pendingData;
        await statusMessage.edit("실행을 취소했습니다.");
        await reaction.remove().catch(() => null);
      } catch {
        // ignore
      }
      return;
    }

    console.log(`[DEBUG] 인식되지 않은 이모지: ${emojiStr}`);
  
  }
  
  // Handle batch action reactions
  if (pendingBatch) {
    // 요청자의 반응만 허용
    if (user.id !== pendingBatch.authorId) {
      console.log(`[DEBUG] 배치 액션 - 요청자 ID 불일치: ${user.id} !== ${pendingBatch.authorId}`);
      return;
    }

    const ageMs = nowMs - pendingBatch.requestedAt;
    console.log(`[DEBUG] 배치 액션 age: ${ageMs}ms, TTL: ${BATCH_ACTION_TTL_MS}ms`);

    // 60초 초과 시 타임아웃
    if (ageMs > BATCH_ACTION_TTL_MS) {
      pendingBatchAction.delete(messageId);
      
      try {
        await reaction.message.edit("확인 시간이 초과되었습니다. 실행이 취소되었습니다.");
      } catch (err) {
        console.log(`[DEBUG] 배치 액션 메시지 편집 실패:`, err.message);
      }
      
      try {
        await reaction.remove().catch(() => null);
      } catch {
        // ignore
      }
      return;
    }

    // ✅ 확인 이모지 체크
    if (emojiStr === "✅") {
      console.log(`[DEBUG] 배치 액션 확인 반응 처리 중...`);
      pendingBatchAction.delete(messageId);
      
      try {
        if (pendingBatch.actionType === "batch_timeout") {
          await handleBatchTimeout(pendingBatch.message, pendingBatch.statusMessage, pendingBatch.durationMinutes, pendingBatch.excludeRoleId);
        } else if (pendingBatch.actionType === "batch_role") {
          await handleBatchRole(pendingBatch.message, pendingBatch.statusMessage, pendingBatch.roleId, pendingBatch.mode);
        } else {
          throw new Error(`Unknown batch action type: ${pendingBatch.actionType}`);
        }
      } catch (err) {
        logError("messageReactionAdd.batch_action", err, {
          messageId,
          userId: user.id,
          actionType: pendingBatch.actionType,
        });
        try {
          await pendingBatch.statusMessage.edit("작업 중 오류가 발생했습니다.");
        } catch {
          // ignore
        }
      } finally {
        try {
          await reaction.remove().catch(() => null);
        } catch {
          // ignore
        }
      }
      return;
    }
    
    // ❌ 취소 이모지 체크
    if (emojiStr === "❌") {
      console.log(`[DEBUG] 배치 액션 취소 반응 처리 중...`);
      pendingBatchAction.delete(messageId);
      
      try {
        await pendingBatch.statusMessage.edit("실행을 취소했습니다.");
      } catch (err) {
        // ignore
      }
      return;
    }

    console.log(`[DEBUG] 배치 액션 - 인식되지 않은 이모지: ${emojiStr}`);
  }
});

process.on("unhandledRejection", (reason) => {
  logError("process.unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  logError("process.uncaughtException", error);
});

client.on("guildCreate", (guild) => {
  console.log(`✅ 봇이 새로운 서버에 추가되었습니다. 서버: ${guild.name} (ID: ${guild.id}), 멤버수: ${guild.memberCount}`);
});

client.once(Events.ClientReady, async () => {
  await registerSlashCommands(client, { profile: "primary" });

  const shardId = client.shard?.ids?.[0] ?? 0;

  console.log(
    `${client.user.tag} 봇이 온라인 상태입니다. 샤드: ${shardId}, 접두사: ${PREFIX}, 현재 모델: ${getCurrentModelName()}`,
  );

  // 스케줄러 시작 (16시/22시 역할 지급, 18시/00시 역할 회수)
  startRoleScheduler(client);
});

client.login(DISCORD_TOKEN);
