import fs from "node:fs";
import path from "node:path";
import { logError } from "./logger.js";

const ASSETS_PATH = path.resolve(process.cwd(), "user_assets.json");
const ADMIN_USER_IDS = new Set(["1269575955626725390"]);

let assets = {};

// JSON 파일 로드
function loadAssets() {
  try {
    if (fs.existsSync(ASSETS_PATH)) {
      const data = fs.readFileSync(ASSETS_PATH, "utf8");
      assets = JSON.parse(data);
    }
  } catch (err) {
    logError("assets.load", err);
    assets = {};
  }
}

// JSON 파일 저장
function saveAssets() {
  try {
    fs.writeFileSync(ASSETS_PATH, JSON.stringify(assets, null, 2), "utf8");
  } catch (err) {
    logError("assets.save", err);
  }
}

loadAssets();

/** JSON 파일의 데이터를 메모리로 다시 불러옵니다. */
export function reloadAssets() {
  loadAssets();
  return Object.keys(assets).length;
}

export function getUserStats(guildId, userId) {
  if (!assets[guildId]) assets[guildId] = {};
  if (!assets[guildId][userId]) {
    assets[guildId][userId] = {
      points: 0,
      unlocked_planets: '["지구"]', // 기존 DB 호환을 위해 문자열 유지
      current_planet: "지구",
      speed_level: 0,
      armor_level: 0,
      admin: ADMIN_USER_IDS.has(userId)
    };
  }

  const stats = assets[guildId][userId];
  let changed = false;

  if (typeof stats.admin !== "boolean") {
    stats.admin = ADMIN_USER_IDS.has(userId);
    changed = true;
  } else if (ADMIN_USER_IDS.has(userId) && stats.admin !== true) {
    stats.admin = true;
    changed = true;
  }

  if (changed) {
    saveAssets();
  }

  return stats;
}

export function addUserPoints(guildId, userId, amount) {
  const stats = getUserStats(guildId, userId);
  stats.points += amount;
  saveAssets();
  return stats.points;
}

export function updateUserStats(guildId, userId, unlockedPlanets, currentPlanet) {
  const stats = getUserStats(guildId, userId);
  stats.unlocked_planets = JSON.stringify(unlockedPlanets);
  stats.current_planet = currentPlanet;
  saveAssets();
}

export function upgradeUserSpeed(guildId, userId) {
  const stats = getUserStats(guildId, userId);
  stats.speed_level += 1;
  saveAssets();
}

export function upgradeUserArmor(guildId, userId) {
  const stats = getUserStats(guildId, userId);
  stats.armor_level += 1;
  saveAssets();
}
