import { ShardingManager } from "discord.js";
import { DISCORD_TOKEN, SHARD_COUNT } from "./config.js";
import { logError } from "./logger.js";

const manager = new ShardingManager("./index.js", {
  token: DISCORD_TOKEN,
  totalShards: SHARD_COUNT === "auto" ? "auto" : Number(SHARD_COUNT),
});

manager.on("shardCreate", (shard) => {
  console.log(`[shard] launched shard ${shard.id}`);
  shard.on("death", () => {
    logError("shard.death", new Error("Shard process died"), { shardId: shard.id });
  });
  shard.on("error", (error) => {
    logError("shard.error", error, { shardId: shard.id });
  });
  shard.on("message", (message) => {
    if (message?.type !== "shutdown") return;
    console.log("[shard] shutdown requested by absolute power user");
    for (const child of manager.shards.values()) {
      try {
        child.kill();
      } catch {
        // ignore shutdown errors
      }
    }
    process.exit(0);
  });
});

manager.spawn().catch((error) => {
  logError("shard.spawn", error);
  process.exit(1);
});
