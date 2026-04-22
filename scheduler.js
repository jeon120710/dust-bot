import { logActionAudit, logError } from "./logger.js";
import { EmbedBuilder } from "discord.js";
import fs from "node:fs";
import path from "node:path";

const GUILD_ID = "1464563536561967233";
const TRIGGER_ROLE_ID = "1464577978565525679";
const TARGET_ROLE_ID = "1495322891422662816";
const CONFIG_PATH = path.resolve(process.cwd(), "scheduler_config.json");

const ROLE_ADD_TIMES = [
  { hour: 16, minute: 0 },
  { hour: 22, minute: 0 },
];
const ROLE_REMOVE_TIMES = [
  { hour: 18, minute: 0 },
  { hour: 0, minute: 0 },
];

const SEOUL_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  hour: "numeric",
  minute: "numeric",
  hour12: false,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatScheduleLabel(schedule) {
  const minuteText = String(schedule.minute).padStart(2, "0");
  return `${schedule.hour}:${minuteText}`;
}

function findMatchingSchedule(schedules, hour, minute) {
  return schedules.find((schedule) => schedule.hour === hour && schedule.minute === minute) ?? null;
}

function getLogChannelId() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return data.logChannelId;
    }
  } catch (err) {
    logError("scheduler.getLogChannelId", err);
  }
  return null;
}

export function setLogChannelId(channelId) {
  const data = { logChannelId: channelId };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf8");
}

/**
 * 특정 서버의 멤버들에게 스케줄에 맞춰 역할을 추가하거나 제거합니다.
 * @param {import("discord.js").Client} client
 * @param {boolean} isAddition true면 추가, false면 제거
 * @param {{hour: number, minute: number} | null} schedule
 */
async function runScheduledRoleUpdate(client, isAddition, schedule = null) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) return;

    await guild.members.fetch().catch(() => null);
    const members = Array.from(guild.members.cache.values());
    let successCount = 0;

    const scheduleLabel = schedule
      ? formatScheduleLabel(schedule)
      : formatScheduleLabel(isAddition ? ROLE_ADD_TIMES[0] : ROLE_REMOVE_TIMES[0]);
    const addReason = `자동 역할 지급 (${scheduleLabel})`;
    const removeReason = `자동 역할 회수 (${scheduleLabel})`;

    for (const member of members) {
      if (member.user.bot) continue;

      try {
        if (isAddition) {
          if (member.roles.cache.has(TRIGGER_ROLE_ID) && !member.roles.cache.has(TARGET_ROLE_ID)) {
            await member.roles.add(TARGET_ROLE_ID, addReason);
            successCount += 1;
            await sleep(1000);
          }
        } else if (member.roles.cache.has(TARGET_ROLE_ID)) {
          await member.roles.remove(TARGET_ROLE_ID, removeReason);
          successCount += 1;
          await sleep(1000);
        }
      } catch {
        // 권한/위계 문제 등 개별 실패는 무시하고 계속 진행
      }
    }

    if (successCount > 0) {
      logActionAudit({
        phase: "success",
        action: isAddition ? "scheduled_role_add" : "scheduled_role_remove",
        guildId: GUILD_ID,
        affectedCount: successCount,
      });
    }

    const logChannelId = getLogChannelId();
    if (!logChannelId) return;

    const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setTitle(isAddition ? "스케줄 역할 지급 완료" : "스케줄 역할 회수 완료")
      .setColor(isAddition ? 0x5865f2 : 0xf1c40f)
      .addFields(
        { name: "처리 서버", value: guild.name, inline: true },
        { name: "대상 역할", value: `<@&${TARGET_ROLE_ID}>`, inline: true },
        { name: "처리 인원", value: `${successCount}명`, inline: true },
        { name: "기준 시간", value: scheduleLabel, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: "자동 스케줄러" });

    await logChannel.send({ embeds: [embed] }).catch(() => null);
  } catch (err) {
    logError("runScheduledRoleUpdate", err);
  }
}

export function startRoleScheduler(client) {
  let lastRunKey = "";
  let isRunning = false;

  async function safeRun(isAddition, schedule) {
    if (isRunning) return;
    isRunning = true;
    try {
      await runScheduledRoleUpdate(client, isAddition, schedule);
    } finally {
      isRunning = false;
    }
  }

  setInterval(() => {
    const now = new Date();
    const parts = SEOUL_TIME_FORMATTER.formatToParts(now);

    const hour = parseInt(parts.find((p) => p.type === "hour").value, 10);
    const minute = parseInt(parts.find((p) => p.type === "minute").value, 10);
    const currentKey = `${hour}:${minute}`;

    if (lastRunKey !== currentKey) {
      lastRunKey = currentKey;
      const matchedAddSchedule = findMatchingSchedule(ROLE_ADD_TIMES, hour, minute);
      if (matchedAddSchedule) safeRun(true, matchedAddSchedule);

      const matchedRemoveSchedule = findMatchingSchedule(ROLE_REMOVE_TIMES, hour, minute);
      if (matchedRemoveSchedule) safeRun(false, matchedRemoveSchedule);
    }
  }, 30000);
}
