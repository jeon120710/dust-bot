import { 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  MessageFlags,
  SlashCommandBuilder
} from "discord.js";
import { addUserPoints, getUserStats, updateUserStats, upgradeUserSpeed, upgradeUserArmor } from "./assets.js";
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

function getBalanceProgress(points) {
  const numericPoints = Number(points);
  const safePoints = Number.isFinite(numericPoints) ? Math.max(0, numericPoints) : 0;
  const logFloor = Math.log10(20000 + 1);
  const logCeiling = Math.log10(2500000 + 1);
  const logPoints = Math.log10(safePoints + 1);
  return smoothstep(logFloor, logCeiling, logPoints);
}

function getRewardBalanceFactor(points, isAdmin = false) {
  if (isAdmin) return 1;
  const progress = getBalanceProgress(points);
  return lerp(1.8, 0.58, progress);
}

function getRepairCostBalanceFactor(points, isAdmin = false) {
  if (isAdmin) return 1;
  const progress = getBalanceProgress(points);
  return lerp(0.55, 1.55, progress);
}

function getRepairProbabilityAdjustment(points, isAdmin = false) {
  if (isAdmin) return 0;
  const progress = getBalanceProgress(points);
  return lerp(-0.08, 0.11, progress);
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
    .setName("우주탐사")
    .setDescription("현재 위치한 행성에서 탐사를 시작합니다."),
  new SlashCommandBuilder()
    .setName("자산")
    .setDescription("나의 보유 포인트와 해금한 행성 목록을 확인합니다."),
  new SlashCommandBuilder()
    .setName("행성")
    .setDescription("행성 이동 및 해금 관리")
    .addSubcommand(sub => sub.setName("목록").setDescription("이동 가능한 행성 목록과 해금 비용을 확인합니다."))
    .addSubcommand(sub => 
      sub.setName("이동")
        .setDescription("해금한 행성으로 이동합니다.")
        .addStringOption(opt => opt.setName("이름").setDescription("이동할 행성 이름").setRequired(true))
    )
    .addSubcommand(sub => 
      sub.setName("해금")
        .setDescription("포인트를 지불하여 새로운 행성을 해금합니다.")
        .addStringOption(opt => opt.setName("이름").setDescription("해금할 행성 이름").setRequired(true))
    ),
  new SlashCommandBuilder()
    .setName("엔진강화")
    .setDescription("포인트를 사용하여 탐사 시간을 단축합니다."),
  new SlashCommandBuilder()
    .setName("수리강화")
    .setDescription("포인트를 사용하여 기체 파손 확률을 낮춥니다."),
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

  if (interaction.commandName === "행성") {
    const sub = interaction.options.getSubcommand();

    if (sub === "목록") {
      const embed = new EmbedBuilder()
        .setTitle("🌌 탐사 가능한 행성 목록")
        .setColor(0x9B59B6);
      
      Object.entries(PLANETS).forEach(([name, data]) => {
        const isUnlocked = unlockedPlanets.includes(name);
        const status = isUnlocked ? "✅ 해금됨" : `🔒 미해금 (비용: ${data.cost.toLocaleString()}P)`;
        embed.addFields({ 
          name: `${name} (보상 ${data.multiplier}배)`, 
          value: `${data.description}\n상태: ${status}` 
        });
      });
      return interaction.reply({ embeds: [embed] });
    }

    if (sub === "이동") {
      const target = interaction.options.getString("이름");
      if (!PLANETS[target]) return interaction.reply({ content: "존재하지 않는 행성입니다.", flags: MessageFlags.Ephemeral });
      if (!unlockedPlanets.includes(target)) return interaction.reply({ content: "아직 해금하지 않은 행성입니다.", flags: MessageFlags.Ephemeral });

      updateUserStats(interaction.guildId, interaction.user.id, unlockedPlanets, target);
      return interaction.reply({ content: `🚀 **${target}**(으)로 이동했습니다! 이제부터 탐사 보상이 **${PLANETS[target].multiplier}배**로 적용됩니다.` });
    }

    if (sub === "해금") {
      const target = interaction.options.getString("이름");
      if (!PLANETS[target]) return interaction.reply({ content: "존재하지 않는 행성입니다.", flags: MessageFlags.Ephemeral });
      if (unlockedPlanets.includes(target)) return interaction.reply({ content: "이미 해금한 행성입니다.", flags: MessageFlags.Ephemeral });
      
      const cost = PLANETS[target].cost;
      if (stats.points < cost) return interaction.reply({ content: `포인트가 부족합니다. (필요: ${cost.toLocaleString()}P / 보유: ${stats.points.toLocaleString()}P)`, flags: MessageFlags.Ephemeral });

      const newUnlocked = [...unlockedPlanets, target];
      addUserPoints(interaction.guildId, interaction.user.id, -cost);
      updateUserStats(interaction.guildId, interaction.user.id, newUnlocked, currentPlanetName);
      
      return interaction.reply({ content: `🌟 성공적으로 **${target}** 행성을 해금했습니다! (지불: ${cost.toLocaleString()}P)` });
    }
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

  // 엔진 및 수리 강화 통합 처리 로직
  if (interaction.commandName === "엔진강화" || interaction.commandName === "수리강화") {
    const isEngine = interaction.commandName === "엔진강화";
    const currentLevel = isEngine ? stats.speed_level : stats.armor_level;
    const typeName = isEngine ? "엔진" : "방호";

    if (currentLevel >= 9) return interaction.reply({ content: `이미 ${typeName}이 최고 레벨(Lv.9)입니다.`, flags: MessageFlags.Ephemeral });

    const upgradeCost = (currentLevel + 1) * (isEngine ? 15000 : 12000);
    
    if (stats.points < upgradeCost) {
      return interaction.reply({ 
        content: `강화 비용이 부족합니다.\n필요: **${upgradeCost.toLocaleString()}P** / 보유: **${stats.points.toLocaleString()}P**`, 
        flags: MessageFlags.Ephemeral 
      });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('confirm_upgrade')
        .setLabel('강화 진행')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('cancel_upgrade')
        .setLabel('취소')
        .setStyle(ButtonStyle.Secondary)
    );

    const response = await interaction.reply({
      content: `🛠 **${typeName} 강화 (Lv.${currentLevel} ➔ Lv.${currentLevel + 1})**\n비용 **${upgradeCost.toLocaleString()}P**가 소요됩니다. 진행하시겠습니까?`,
      components: [row],
      fetchReply: true
    });

    const collector = response.createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id,
      time: 30000
    });

    collector.on('collect', async (i) => {
      if (i.customId === 'confirm_upgrade') {
        // 버튼 클릭 시점에 포인트 재확인
        const freshStats = getUserStats(interaction.guildId, interaction.user.id);
        if (freshStats.points < upgradeCost) {
          return i.update({ content: "그새 포인트가 부족해졌습니다...", components: [] });
        }

        addUserPoints(interaction.guildId, interaction.user.id, -upgradeCost);
        if (isEngine) {
          upgradeUserSpeed(interaction.guildId, interaction.user.id);
        } else {
          upgradeUserArmor(interaction.guildId, interaction.user.id);
        }

        await i.update({ 
          content: `✅ **${typeName} 강화 성공!**\n레벨: Lv.${currentLevel + 1}\n지불: -${upgradeCost.toLocaleString()}P`, 
          components: [] 
        });
      } else {
        await i.update({ content: "강화를 취소했습니다.", components: [] });
      }
      collector.stop();
    });

    collector.on('end', collected => {
      if (collected.size === 0) {
        interaction.editReply({ content: "시간이 초과되어 강화를 취소했습니다.", components: [] }).catch(() => {});
      }
    });
    return;
  }

  // 요청하신 확률 로직: 숫자 2개를 뽑아 비교
  const explorationKey = `${interaction.guildId || "dm"}:${interaction.user.id}`;
  const nowMs = Date.now();
  const activeUntil = Number(activeSpaceExplorations.get(explorationKey) || 0);
  if (activeUntil > nowMs) {
    const remainingSeconds = Math.max(1, Math.ceil((activeUntil - nowMs) / 1000));
    return interaction.reply({
      content: `이미 우주선이 발사되어 탐사 중입니다. 약 ${remainingSeconds}초 후 다시 시도해 주세요.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (activeUntil > 0) {
    activeSpaceExplorations.delete(explorationKey);
  }

  const threshold = Math.floor(Math.random() * 100) + 1; // 기준 확률 (1~100)
  
  // 시간 계산 (최소 탐사 시간 상향으로 고레벨 초고속 파밍 완화)
  const minTime = ECONOMY_BALANCE.minExplorationTime;
  const waitTime = Math.max(minTime, Math.floor(planetData.baseTime - (stats.speed_level * (planetData.baseTime - minTime) / 9)));
  const arrivalTimestamp = Math.floor(Date.now() / 1000) + waitTime;

  // 1. 초기 출발 메시지 전송
  const startEmbed = new EmbedBuilder()
    .setTitle(`🚀 ${currentPlanetName}에서 우주선 출발 중...`)
    .setDescription(`성공 확률: **${threshold}%** | 보상 배율: **${planetData.multiplier}배**\n도착 예정: <t:${arrivalTimestamp}:R>`)
    .setColor(0x3498db)
    .setTimestamp();

  const explorationEndsAt = Date.now() + (waitTime * 1000);
  activeSpaceExplorations.set(explorationKey, explorationEndsAt);

  try {
    await interaction.reply({ embeds: [startEmbed] });

  // 탐사 시간만큼 대기
  await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));

  const roll = Math.floor(Math.random() * 100) + 1; // 주사위 (1~100)

  const embed = new EmbedBuilder()
    .setAuthor({ name: interaction.user.displayName, iconURL: interaction.user.displayAvatarURL() })
    .setTimestamp();

  let pointsAwarded = 0;

  if (roll < threshold) {
    // 성공 시 (보상 결정)
    const rewardRoll = Math.random();
    const baseRewardFactor = getRewardBalanceFactor(stats.points, isAdminUser);
    const rewardFactor = sampleNaturalizedFactor(baseRewardFactor, isAdminUser);
    let basePointsAwarded = 0;
    if (rewardRoll < 0.15) { // 15% 확률로 희귀 아이템
      basePointsAwarded = Math.round(2000 * planetData.multiplier);
      pointsAwarded = applyBalancedReward(basePointsAwarded, rewardFactor);
      const balanceText = isAdminUser ? "" : `\n(경제 밸런스 보정 x${rewardFactor.toFixed(2)})`;
      embed.setTitle("🌟 희귀 아이템 획득!")
        .setDescription(`축하합니다! 깊은 우주에서 고대의 유물을 발견했습니다. (**+${pointsAwarded} 포인트**)\n(판정: ${roll} < ${threshold})${balanceText}`)
        .setColor(0xFFA500);
    } else { // 나머지 확률로 코인/포인트
      basePointsAwarded = Math.round((Math.floor(Math.random() * 500) + 100) * planetData.multiplier);
      pointsAwarded = applyBalancedReward(basePointsAwarded, rewardFactor);
      const balanceText = isAdminUser ? "" : `\n(경제 밸런스 보정 x${rewardFactor.toFixed(2)})`;
      embed.setTitle(`🪐 ${currentPlanetName} 탐사 성공`)
        .setDescription(`안전하게 착륙하여 **${pointsAwarded}포인트**를 채굴했습니다.\n(판정: ${roll} < ${threshold})${balanceText}`)
        .setColor(0x00FF00);
    }

    // 실제 포인트 지급 및 총액 확인
    const totalPoints = addUserPoints(interaction.guildId, interaction.user.id, pointsAwarded);
    embed.addFields({ name: "현재 보유 포인트", value: `💰 **${totalPoints.toLocaleString()}** 포인트` });

  } else {
    // 실패 시 (랜덤 실패 이벤트)
    const repairRoll = Math.random();
    let repairText = "";
    const failureEvent = EXPLORATION_FAILURE_EVENTS[Math.floor(Math.random() * EXPLORATION_FAILURE_EVENTS.length)];

    // 기본 파손 확률 40%, 방호 레벨당 4% 감소 + 자산 구간별 보정
    const baseRepairProb = Math.max(0.04, 0.4 - (stats.armor_level * 0.04));
    const baseRepairProbAdjustment = getRepairProbabilityAdjustment(stats.points, isAdminUser);
    const repairProbAdjustment = sampleNaturalizedProbabilityAdjustment(baseRepairProbAdjustment, isAdminUser);
    const repairProb = clamp(baseRepairProb + repairProbAdjustment, 0.02, 0.85);
    const baseRepairCostFactor = getRepairCostBalanceFactor(stats.points, isAdminUser);
    const repairCostFactor = sampleNaturalizedFactor(baseRepairCostFactor, isAdminUser);

    if (repairRoll < repairProb) { // 계산된 확률로 수리비 발생
      const baseRepairCost = Math.round((Math.floor(Math.random() * 401) + 100) * planetData.multiplier);
      const repairCost = applyBalancedRepairCost(baseRepairCost, repairCostFactor);
      const totalPoints = addUserPoints(interaction.guildId, interaction.user.id, -repairCost);
      const balanceText = isAdminUser ? "" : `\n(경제 밸런스 보정 x${repairCostFactor.toFixed(2)})`;
      repairText = `\n\n🛠 **기체 파손 경고!** 무사히 탈출했으나 우주선 수리비가 발생했습니다.\n차감: **-${repairCost.toLocaleString()}P** (남은 포인트: ${totalPoints.toLocaleString()}P)${balanceText}`;
      embed.setColor(0xE67E22); // 주황색으로 경고 표시
    } else {
      embed.setColor(0xFF0000);
    }

    embed.setTitle(failureEvent.title)
      .setDescription(`${failureEvent.reason}\n(판정: ${roll} >= ${threshold} / 파손 확률: ${Math.round(repairProb * 100)}%)${repairText}`);
  }

  // 버튼 추가 (재탐사를 유도하는 버튼)
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('re_explore')
      .setLabel('다시 탐사하기 (명령어 사용)')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true) // 명령어 안내용으로 비활성 처리하거나, 필요 시 로직 연결 가능
  );

    return interaction.editReply({ embeds: [embed], components: [row] });
  } finally {
    activeSpaceExplorations.delete(explorationKey);
  }
}
