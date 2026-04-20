import { logError } from "./logger.js";
import { SlashCommandBuilder } from "discord.js";

async function registerSlashCommands(client, options = {}) {
  const shardId = client.shard?.ids?.[0] ?? 0;
  const { profile = "primary" } = options;

  const SCHEDULER_COMMANDS = [
    new SlashCommandBuilder()
      .setName("스케줄설정")
      .setDescription("역할 스케줄러 설정을 관리합니다.")
      .addSubcommand(sub =>
        sub.setName("로그채널")
          .setDescription("결과 보고를 받을 관리자 채널을 설정합니다.")
          .addChannelOption(opt => opt.setName("채널").setDescription("알림을 받을 채널").setRequired(true))
      )
  ].map(cmd => cmd.toJSON());

  try {
    // 1. 기존 명령어 완전 초기화
    console.log(`[DEBUG] 슬래시 명령어 초기화 시작... (Shard: ${shardId})`);
    
    // 모든 서버(Guild)에 등록된 명령어 삭제 (옛날 테스트용 명령어 제거)
    for (const guild of client.guilds.cache.values()) {
      await guild.commands.set([]).catch(() => {});
    }
    // 글로벌 명령어 리스트 초기화 (Atomic하게 덮어쓰기 전 안전장치)
    await client.application.commands.set([]);

    let commandDataList = [];
    if (profile === "primary") {
      const { TYPING_COMMANDS } = await import("./typing.js");
      const { SPACE_COMMANDS } = await import("./space.js");
      commandDataList = [...TYPING_COMMANDS, ...SCHEDULER_COMMANDS, ...SPACE_COMMANDS];
    }

    // 2. 현재 정의된 명령어로 새로 등록
    await client.application.commands.set(commandDataList);

    const commandNames = commandDataList.map((cmd) => `/${cmd.name}`).join(", ") || "(없음)";
    const profileLabel = profile === "primary" ? "메인" : "보조";
    console.log(`✅ ${profileLabel} 슬래시 명령어 초기화 및 재등록 완료: ${commandNames}`);
  } catch (err) {
    logError("ready.registerSlashCommands", err, { shardId, profile });
  }
}

export { registerSlashCommands };
