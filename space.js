import { 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  MessageFlags,
  SlashCommandBuilder
} from "discord.js";
import { addUserPoints, getGuildEconomySnapshot, getUserStats, updateUserStats, upgradeUserSpeed, upgradeUserArmor } from "./assets.js";
import { logActionAudit } from "./logger.js";

const activeSpaceExplorations = new Map();

function getDefaultPlanetName() {
  const names = Object.keys(PLANETS);
  return names.length > 0 ? names[0] : "";
}

function parseUnlockedPlanets(rawValue, defaultPlanetName) {
  try {
    const parsed = JSON.parse(String(rawValue || "[]"));
    if (!Array.isArray(parsed)) {
      return defaultPlanetName ? [defaultPlanetName] : [];
    }
    const filtered = parsed.filter((name) => typeof name === "string" && PLANETS[name]);
    if (filtered.length > 0) {
      return Array.from(new Set(filtered));
    }
  } catch {
    // fallback below
  }
  return defaultPlanetName ? [defaultPlanetName] : [];
}

export const PLANETS = {
  "지구": { cost: 0, multiplier: 1, baseTime: 30, description: "평화로운 시작의 행성입니다. (기본 30초)" },
  "화성": { cost: 10000, multiplier: 1.8, baseTime: 60, description: "척박하지만 자원이 풍부한 붉은 행성입니다. (기본 1분)" },
  "목성": { cost: 50000, multiplier: 3.2, baseTime: 300, description: "거대한 가스 행성으로, 안정적인 고효율 채굴이 가능합니다. (기본 5분)" },
  "안드로메다": { cost: 250000, multiplier: 5.5, baseTime: 600, description: "심우주의 끝자락, 위험과 보상이 공존하는 최상위 구역입니다. (기본 10분)" }
};

const EXPLORATION_FAILURE_EVENTS = [
  { title: "☄️ 탐사 실패 (블랙홀)", reason: "블랙홀의 중력에 휘말려 비상 탈출만 간신히 성공했습니다." },
  { title: "☄️ 탐사 실패 (소행성 폭풍)", reason: "예상치 못한 소행성 폭풍으로 채굴 구역 진입에 실패했습니다." },
  { title: "☄️ 탐사 실패 (태양 플레어)", reason: "강력한 태양 플레어로 센서가 마비되어 귀환을 선택했습니다." },
  { title: "☄️ 탐사 실패 (엔진 과열)", reason: "장거리 항해 중 엔진 온도가 한계치를 넘어 임무를 중단했습니다." },
  { title: "☄️ 탐사 실패 (항법 오류)", reason: "중력 교란으로 항법 좌표가 틀어져 목표 지점에 도달하지 못했습니다." },
  { title: "☄️ 탐사 실패 (통신 두절)", reason: "우주 전파 간섭으로 관제와의 통신이 끊겨 즉시 복귀했습니다." },
  { title: "☄️ 탐사 실패 (연료 누출)", reason: "연료 누출 경고가 발생해 안전 절차에 따라 탐사를 포기했습니다." },
  { title: "☄️ 탐사 실패 (우주 해적 조우)", reason: "미확인 약탈선과 조우해 전투를 피하고 후퇴했습니다." },
  { title: "☄️ 탐사 실패 (방사선 폭증)", reason: "고에너지 방사선 수치가 급상승해 장비 보호를 위해 철수했습니다." },
  { title: "☄️ 탐사 실패 (중력 난류)", reason: "불안정한 중력 난류로 착륙 시퀀스가 무너져 탐사에 실패했습니다." }
];

const ECONOMY_BALANCE = {
  minExplorationTime: 20,
  minimumEconomySampleSize: 4,
  lowWealthRewardFactor: 1.24,
  highWealthRewardFactor: 0.86,
  lowWealthRepairCostFactor: 0.88,
  highWealthRepairCostFactor: 1.16,
  lowWealthRepairProbabilityAdjustment: -0.025,
  highWealthRepairProbabilityAdjustment: 0.035,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(start, end, t) {
  return start + ((end - start) * t);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return (t * t) * (3 - (2 * t));
}

function getLogPoint(value) {
  return Math.log10(Math.max(0, Number(value) || 0) + 1);
}

function getBalancePosition(points, economySnapshot) {
  const numericPoints = Number(points);
  const safePoints = Number.isFinite(numericPoints) ? Math.max(0, numericPoints) : 0;

  let lowAnchor = 20000;
  let centerAnchor = 250000;
  let highAnchor = 2500000;

  if (economySnapshot?.count >= ECONOMY_BALANCE.minimumEconomySampleSize && economySnapshot.median > 0) {
    centerAnchor = economySnapshot.median;
    lowAnchor = Math.max(1, Math.min(economySnapshot.p25, centerAnchor * 0.45));
    highAnchor = Math.max(economySnapshot.p90, centerAnchor * 1.8, centerAnchor + 1);
  }

  const logPoints = getLogPoint(safePoints);
  const logLow = getLogPoint(Math.min(lowAnchor, centerAnchor - 1));
  const logCenter = getLogPoint(centerAnchor);
  const logHigh = getLogPoint(Math.max(highAnchor, centerAnchor + 1));

  if (logPoints < logCenter) {
    return -1 + smoothstep(logLow, logCenter, logPoints);
  }
  return smoothstep(logCenter, logHigh, logPoints);
}

function getBalanceFactorFromPosition(position, lowWealthFactor, highWealthFactor) {
  if (position < 0) {
    return lerp(1, lowWealthFactor, Math.abs(position));
  }
  return lerp(1, highWealthFactor, position);
}

function getRewardBalanceFactor(points, economySnapshot, isAdmin = false) {
  if (isAdmin) return 1;
  const position = getBalancePosition(points, economySnapshot);
  return getBalanceFactorFromPosition(position, ECONOMY_BALANCE.lowWealthRewardFactor, ECONOMY_BALANCE.highWealthRewardFactor);
}

function getRepairCostBalanceFactor(points, economySnapshot, isAdmin = false) {
  if (isAdmin) return 1;
  const position = getBalancePosition(points, economySnapshot);
  return getBalanceFactorFromPosition(position, ECONOMY_BALANCE.lowWealthRepairCostFactor, ECONOMY_BALANCE.highWealthRepairCostFactor);
}

function getRepairProbabilityAdjustment(points, economySnapshot, isAdmin = false) {
  if (isAdmin) return 0;
  const position = getBalancePosition(points, economySnapshot);
  if (position < 0) {
    return lerp(0, ECONOMY_BALANCE.lowWealthRepairProbabilityAdjustment, Math.abs(position));
  }
  return lerp(0, ECONOMY_BALANCE.highWealthRepairProbabilityAdjustment, position);
}

function sampleNaturalizedFactor(targetFactor, isAdmin = false) {
  if (!Number.isFinite(targetFactor)) return 1;
  if (isAdmin) return targetFactor;

  const neutral = 1;
  const diff = Math.abs(targetFactor - neutral);
  if (diff < 0.01) return targetFactor;

  const softenChance = clamp(0.35 + (diff * 0.7), 0.35, 0.82);
  let sampledFactor = targetFactor;

  if (Math.random() < softenChance) {
    const blendToNeutral = 0.25 + (Math.random() * 0.55);
    sampledFactor = lerp(targetFactor, neutral, blendToNeutral);
  } else {
    const jitter = 1 + ((Math.random() - 0.5) * 0.16);
    sampledFactor = targetFactor * jitter;
  }

  return clamp(sampledFactor, 0.45, 2.0);
}

function sampleNaturalizedProbabilityAdjustment(targetAdjustment, isAdmin = false) {
  if (!Number.isFinite(targetAdjustment)) return 0;
  if (isAdmin) return targetAdjustment;

  const neutral = 0;
  const diff = Math.abs(targetAdjustment - neutral);
  if (diff < 0.001) return targetAdjustment;

  const softenChance = clamp(0.4 + (diff * 2.5), 0.4, 0.88);
  let sampledAdjustment = targetAdjustment;

  if (Math.random() < softenChance) {
    const blendToNeutral = 0.2 + (Math.random() * 0.6);
    sampledAdjustment = lerp(targetAdjustment, neutral, blendToNeutral);
  } else {
    const jitter = (Math.random() - 0.5) * 0.03;
    sampledAdjustment = targetAdjustment + jitter;
  }

  return clamp(sampledAdjustment, -0.12, 0.14);
}

function applyBalancedReward(baseReward, factor = 1) {
  return Math.max(1, Math.floor(baseReward * factor));
}

function applyBalancedRepairCost(baseCost, factor = 1) {
  return Math.max(1, Math.floor(baseCost * factor));
}

export const SPACE_COMMANDS = [
  new SlashCommandBuilder()
    .setName("자산")
    .setDescription("나의 보유 포인트와 해금한 행성 목록을 확인합니다."),
  new SlashCommandBuilder()
    .setName("송금")
    .setDescription("다른 유저에게 포인트를 보냅니다.")
    .addUserOption(opt => opt.setName("대상").setDescription("포인트를 받을 유저").setRequired(true))
    .addIntegerOption(opt => opt.setName("금액").setDescription("보낼 포인트 양").setRequired(true).setMinValue(1))
].map(cmd => cmd.toJSON());

/**
 * 우주 탐사 인터랙션을 처리합니다.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction 
 */
export async function handleSpaceInteraction(interaction) {
  const ALLOWED_GUILD_ID = "1464563536561967233";
  const ALLOWED_CHANNEL_ID = "1485074044050214962";

  // 서버 및 채널 제한 확인
  if (interaction.guildId !== ALLOWED_GUILD_ID || interaction.channelId !== ALLOWED_CHANNEL_ID) {
    return interaction.reply({ 
      content: `이 명령어는 전용 채널(<#${ALLOWED_CHANNEL_ID}>)에서만 사용할 수 있습니다.`, 
      flags: MessageFlags.Ephemeral 
    });
  }

  const stats = getUserStats(interaction.guildId, interaction.user.id);
  const isAdminUser = stats.admin === true;
  const economySnapshot = getGuildEconomySnapshot(interaction.guildId);
  const defaultPlanetName = getDefaultPlanetName();
  const unlockedPlanets = parseUnlockedPlanets(stats.unlocked_planets, defaultPlanetName);
  const currentPlanetName = PLANETS[stats.current_planet] ? stats.current_planet : defaultPlanetName;
  const planetData = PLANETS[currentPlanetName] || { multiplier: 1, baseTime: 30 };

  if (interaction.commandName === "자산") {
    const embed = new EmbedBuilder()
      .setTitle(`💰 ${interaction.user.displayName}님의 우주 자산`)
      .setColor(0xF1C40F)
      .addFields(
        { name: "보유 포인트", value: `**${stats.points.toLocaleString()}** P`, inline: true },
        { name: "현재 위치", value: `📍 **${currentPlanetName}**`, inline: true },
        { name: "엔진 레벨", value: `Lv.${stats.speed_level} (시간 단축)`, inline: true },
        { name: "방호 레벨", value: `Lv.${stats.armor_level} (파손 확률 -${stats.armor_level * 4}%)`, inline: true },
        { name: "해금된 행성", value: unlockedPlanets.join(", ") }
      )
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === "송금") {
    const targetUser = interaction.options.getUser("대상");
    const amount = interaction.options.getInteger("금액");

    if (targetUser.id === interaction.user.id) {
      return interaction.reply({ content: "자기 자신에게는 송금할 수 없습니다.", flags: MessageFlags.Ephemeral });
    }
    if (targetUser.bot) {
      return interaction.reply({ content: "봇에게는 송금할 수 없습니다.", flags: MessageFlags.Ephemeral });
    }
    const targetStats = getUserStats(interaction.guildId, targetUser.id);
    if (isAdminUser || targetStats.admin === true) {
      return interaction.reply({ content: "어드민 계정은 송금에 참여할 수 없습니다.", flags: MessageFlags.Ephemeral });
    }
    if (stats.points < amount) {
      return interaction.reply({ 
        content: `포인트가 부족합니다. (보유: ${stats.points.toLocaleString()}P / 필요: ${amount.toLocaleString()}P)`, 
        flags: MessageFlags.Ephemeral 
      });
    }

    addUserPoints(interaction.guildId, interaction.user.id, -amount);
    addUserPoints(interaction.guildId, targetUser.id, amount);

    logActionAudit({
      phase: "success",
      action: "space.transfer",
      guildId: interaction.guildId,
      userId: interaction.user.id,
      targetUserId: targetUser.id,
      amount: amount,
    });

    const embed = new EmbedBuilder()
      .setTitle("💸 포인트 송금 완료")
      .setDescription(`<@${interaction.user.id}>님이 <@${targetUser.id}>님에게 포인트를 보냈습니다.`)
      .addFields(
        { name: "송금 금액", value: `**${amount.toLocaleString()}** P`, inline: true },
        { name: "나의 잔액", value: `**${(stats.points - amount).toLocaleString()}** P`, inline: true }
      )
      .setColor(0x2ECC71)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  return false;
}
