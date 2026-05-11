import { logError } from "./logger.js";

async function registerSlashCommands(client, options = {}) {
  const shardId = client.shard?.ids?.[0] ?? 0;
  const { profile = "primary" } = options;

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
      const { GAMBLE_COMMANDS } = await import("./gamble.js");
      commandDataList = [...TYPING_COMMANDS, ...SPACE_COMMANDS, ...GAMBLE_COMMANDS];
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
