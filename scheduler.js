import { logActionAudit, logError } from "./logger.js";
import { EmbedBuilder } from "discord.js";
import fs from "node:fs";
import path from "node:path";

const GUILD_ID = "1464563536561967233";
const TRIGGER_ROLE_ID = "1464577978565525679";
const TARGET_ROLE_ID = "1495322891422662816";
const CONFIG_PATH = path.resolve(process.cwd(), "scheduler_config.json");

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
 * 특정 서버의 멤버들에게 역할을 추가하거나 제거합니다.
 * @param {import("discord.js").Client} client 
 * @param {boolean} isAddition true면 추가, false면 제거
 */
async function runScheduledRoleUpdate(client, isAddition) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) return;

    // 모든 멤버 정보를 최신화 (캐시 업데이트)
    await guild.members.fetch().catch(() => null);
    const members = Array.from(guild.members.cache.values());
    let successCount = 0;

    for (const member of members) {
      if (member.user.bot) continue;

      try {
        if (isAddition) {
          // 21:30 - 조건 역할이 있고 대상 역할이 없는 유저에게 부여
          if (member.roles.cache.has(TRIGGER_ROLE_ID) && !member.roles.cache.has(TARGET_ROLE_ID)) {
            await member.roles.add(TARGET_ROLE_ID, "자동 역할 지급 (21:30)");
            successCount++;
            await new Promise((r) => setTimeout(r, 1000)); // API 속도 제한 방지
          }
        } else {
          // 03:00 - 대상 역할을 가진 유저에게서 회수
          if (member.roles.cache.has(TARGET_ROLE_ID)) {
            await member.roles.remove(TARGET_ROLE_ID, "자동 역할 회수 (03:00)");
            successCount++;
            await new Promise((r) => setTimeout(r, 1000)); // API 속도 제한 방지
          }
        }
      } catch (err) {
        // 권한 부족 등 개별 오류는 무시하고 계속 진행
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

    // 관리자 채널에 결과 전송 (임베드)
    const logChannelId = getLogChannelId();
    if (logChannelId) {
      const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
      if (logChannel && logChannel.isTextBased()) {
        const embed = new EmbedBuilder()
          .setTitle(isAddition ? "🌙 야간 역할 자동 지급 완료" : "☀️ 새벽 역할 자동 회수 완료")
          .setColor(isAddition ? 0x5865f2 : 0xf1c40f)
          .addFields(
            { name: "처리 서버", value: guild.name, inline: true },
            { name: "대상 역할", value: `<@&${TARGET_ROLE_ID}>`, inline: true },
            { name: "처리 인원", value: `${successCount}명`, inline: true },
            { name: "기준 시간", value: isAddition ? "21:30" : "03:00", inline: true }
          )
          .setTimestamp()
          .setFooter({ text: "자동 스케줄러 시스템" });

        await logChannel.send({ embeds: [embed] }).catch(() => null);
      }
    }

  } catch (err) {
    logError("runScheduledRoleUpdate", err);
  }
}

export function startRoleScheduler(client) {
  let lastRunKey = "";

  setInterval(() => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);

    const hour = parseInt(parts.find((p) => p.type === "hour").value, 10);
    const minute = parseInt(parts.find((p) => p.type === "minute").value, 10);
    const currentKey = `${hour}:${minute}`;

    if (lastRunKey !== currentKey) {
      lastRunKey = currentKey;
      if (hour === 22 && minute === 30) runScheduledRoleUpdate(client, true);
      if (hour === 1 && minute === 0) runScheduledRoleUpdate(client, false);
    }
  }, 30000); // 30초마다 체크하여 정각 실행 보장
}