import dotenv from "dotenv";

dotenv.config();

export const PREFIX = "!먼지야";
const GOOGLE_MODEL_CANDIDATES = [
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "gemma-3-12b-it",
];
export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMMA_API_KEY;
export const MODEL_CANDIDATES = [
  ...(GOOGLE_API_KEY ? GOOGLE_MODEL_CANDIDATES : []),
];
export const FORCE_MODEL_NAME = String(process.env.FORCE_MODEL_NAME || "").trim();
export const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
export const DISCORD_TOKEN2 = process.env.DISCORD_TOKEN2;
export const ABSOLUTE_POWER_USER_ID = process.env.ABSOLUTE_POWER_USER_ID || "1269575955626725390";
export const LOG_FILE_PATH = process.env.LOG_FILE_PATH || "logs/bot-events.jsonl";
export const SHARD_COUNT = process.env.SHARD_COUNT || "auto";

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN이 설정되어 있지 않습니다. .env를 확인하세요.");
  process.exit(1);
}
