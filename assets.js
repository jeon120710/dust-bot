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

function percentile(sortedValues, percentileRank) {
  if (sortedValues.length === 0) return 0;
  const index = (sortedValues.length - 1) * percentileRank;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + ((sortedValues[upper] - sortedValues[lower]) * (index - lower));
}

export function getGuildEconomySnapshot(guildId) {
  const guildAssets = assets[guildId] || {};
  const points = Object.values(guildAssets)
    .filter((stats) => stats && stats.admin !== true)
    .map((stats) => Number(stats.points))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  return {
    count: points.length,
    p25: percentile(points, 0.25),
    median: percentile(points, 0.5),
    p75: percentile(points, 0.75),
    p90: percentile(points, 0.9),
  };
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
