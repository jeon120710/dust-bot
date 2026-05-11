import fs from "node:fs";
import path from "node:path";
import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import { addUserPoints, getUserStats } from "./assets.js";
import { logActionAudit, logError } from "./logger.js";

const GAMBLE_DATA_PATH = path.resolve(process.cwd(), "gamble_data.json");
const LOTTERY_TICKET_PRICE = 1000;
const MAX_LOTTERY_TICKETS = 10;
const GAMBLE_MIN_BET = 1000;
const DAILY_REWARD_AMOUNT = 10000;
const GAMBLE_WIN_RATE = 0.45;
const GAMBLE_REVEAL_DELAY_MS = 1500;

let gambleData = {};

const GAMBLE_COMMANDS = [
  new SlashCommandBuilder()
    .setName("도박")
    .setDescription("포인트를 걸고 승부합니다.")
    .addIntegerOption((opt) =>
      opt
        .setName("금액")
        .setDescription(`걸 포인트 (최소 ${GAMBLE_MIN_BET.toLocaleString("ko-KR")}P)`)
        .setRequired(true)
        .setMinValue(GAMBLE_MIN_BET),
    ),
  new SlashCommandBuilder()
    .setName("출석")
    .setDescription(`하루에 한 번 ${DAILY_REWARD_AMOUNT.toLocaleString("ko-KR")}P를 받습니다.`),
  new SlashCommandBuilder()
    .setName("복권")
    .setDescription("복권을 구매해 당첨을 노립니다.")
    .addIntegerOption((opt) =>
      opt
        .setName("개수")
        .setDescription(`구매할 복권 수 (1~${MAX_LOTTERY_TICKETS})`)
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(MAX_LOTTERY_TICKETS),
    ),
  new SlashCommandBuilder()
    .setName("자산")
    .setDescription("보유 포인트와 도박 기록을 확인합니다.")
    .addUserOption((opt) =>
      opt
        .setName("대상")
        .setDescription("자산을 확인할 유저")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("송금")
    .setDescription("다른 유저에게 포인트를 보냅니다.")
    .addUserOption((opt) =>
      opt
        .setName("대상")
        .setDescription("포인트를 받을 유저")
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("금액")
        .setDescription("보낼 포인트")
        .setRequired(true)
        .setMinValue(1),
    ),
].map((cmd) => cmd.toJSON());

function loadGambleData() {
  try {
    if (!fs.existsSync(GAMBLE_DATA_PATH)) {
      gambleData = {};
      return;
    }

    gambleData = JSON.parse(fs.readFileSync(GAMBLE_DATA_PATH, "utf8"));
  } catch (err) {
    logError("gamble.load", err);
    gambleData = {};
  }
}

function saveGambleData() {
  try {
    fs.writeFileSync(GAMBLE_DATA_PATH, JSON.stringify(gambleData, null, 2), "utf8");
  } catch (err) {
    logError("gamble.save", err);
  }
}

function getGambleStats(guildId, userId) {
  if (!gambleData[guildId]) gambleData[guildId] = {};
  if (!gambleData[guildId][userId]) {
    gambleData[guildId][userId] = {
      updatedAt: new Date().toISOString(),
    };
  }
  if (!gambleData[guildId][userId].gambling) {
    gambleData[guildId][userId].gambling = {
      plays: 0,
      wins: 0,
      losses: 0,
      staked: 0,
      profit: 0,
      bestWin: 0,
    };
  }
  if (!gambleData[guildId][userId].lottery) {
    gambleData[guildId][userId].lottery = {
      tickets: 0,
      wins: 0,
      jackpots: 0,
      spent: 0,
      prize: 0,
      profit: 0,
      bestPrize: 0,
    };
  }
  if (!gambleData[guildId][userId].daily) {
    gambleData[guildId][userId].daily = {
      lastClaimDate: "",
      claims: 0,
      totalClaimed: 0,
    };
  }
  return gambleData[guildId][userId];
}

function formatPoints(value) {
  return `${Math.trunc(Number(value) || 0).toLocaleString("ko-KR")}P`;
}

function buildBaseEmbed(interaction, title, color, user = interaction.user) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setAuthor({
      name: user.globalName || user.username,
      iconURL: user.displayAvatarURL({ size: 128 }),
    })
    .setTimestamp();
}

function getKoreanDateKey(date = new Date()) {
  return new Date(date.getTime() + (9 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function updateGambleRecord(record, amount, delta) {
  record.gambling.plays += 1;
  record.gambling.staked += amount;
  record.gambling.profit += delta;
  if (delta > 0) {
    record.gambling.wins += 1;
    record.gambling.bestWin = Math.max(record.gambling.bestWin, delta);
  } else {
    record.gambling.losses += 1;
  }
  record.updatedAt = new Date().toISOString();
}

function drawLotteryTicket() {
  const roll = Math.random();
  if (roll < 0.01) return { label: "잭팟", multiplier: 50, color: 0xf1c40f };
  if (roll < 0.05) return { label: "대박", multiplier: 5, color: 0x2ecc71 };
  if (roll < 0.20) return { label: "당첨", multiplier: 2, color: 0x3498db };
  return { label: "꽝", multiplier: 0, color: 0x95a5a6 };
}

async function replyError(interaction, message) {
  await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

async function handleGambleCommand(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const amount = interaction.options.getInteger("금액", true);
  const userStats = getUserStats(guildId, userId);
  const balance = Number(userStats.points) || 0;

  if (amount < GAMBLE_MIN_BET) {
    await replyError(interaction, `최소 배팅 금액은 ${formatPoints(GAMBLE_MIN_BET)}입니다.`);
    return;
  }

  if (amount > balance) {
    await replyError(interaction, `보유 포인트가 부족합니다. 현재 잔액: ${formatPoints(balance)}`);
    return;
  }

  const chanceEmbed = buildBaseEmbed(interaction, "도박 확률", 0xf1c40f)
    .setDescription("승부를 시작합니다.")
    .addFields(
      { name: "성공 확률", value: `${Math.round(GAMBLE_WIN_RATE * 100)}%`, inline: true },
      { name: "실패 확률", value: `${Math.round((1 - GAMBLE_WIN_RATE) * 100)}%`, inline: true },
      { name: "건 금액", value: formatPoints(amount), inline: true },
      { name: "성공 시", value: `+${formatPoints(amount)}`, inline: true },
      { name: "실패 시", value: `-${formatPoints(amount)}`, inline: true },
      { name: "현재 잔액", value: formatPoints(balance), inline: true },
    )
    .setFooter({ text: "성공하면 건 돈만큼 지급, 실패하면 건 돈만큼 차감" });

  await interaction.reply({ embeds: [chanceEmbed] });

  await new Promise((resolve) => setTimeout(resolve, GAMBLE_REVEAL_DELAY_MS));

  const win = Math.random() < GAMBLE_WIN_RATE;
  const delta = win ? amount : -amount;
  const newBalance = addUserPoints(guildId, userId, delta);
  const record = getGambleStats(guildId, userId);
  updateGambleRecord(record, amount, delta);
  saveGambleData();

  const embed = buildBaseEmbed(interaction, win ? "도박 성공" : "도박 실패", win ? 0x2ecc71 : 0xe74c3c)
    .setDescription(win ? "승부가 통했습니다. 건 만큼 획득했어요." : "이번 판은 아쉽게 졌습니다.")
    .addFields(
      { name: "건 금액", value: formatPoints(amount), inline: true },
      { name: win ? "획득" : "손실", value: formatPoints(Math.abs(delta)), inline: true },
      { name: "현재 잔액", value: formatPoints(newBalance), inline: true },
      { name: "누적 전적", value: `${record.gambling.wins}승 ${record.gambling.losses}패`, inline: true },
      { name: "누적 손익", value: formatPoints(record.gambling.profit), inline: true },
      { name: "최고 수익", value: formatPoints(record.gambling.bestWin), inline: true },
    )
    .setFooter({ text: "성공 시 건 돈만큼 지급 / 실패 시 건 돈만큼 차감" });

  await interaction.editReply({ embeds: [embed] });
}

async function handleDailyCommand(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const todayKey = getKoreanDateKey();
  const record = getGambleStats(guildId, userId);

  if (record.daily.lastClaimDate === todayKey) {
    const embed = buildBaseEmbed(interaction, "출석 보상", 0x95a5a6)
      .setDescription("오늘 출석 보상은 이미 받았습니다.")
      .addFields(
        { name: "오늘 날짜", value: todayKey, inline: true },
        { name: "일일 보상", value: formatPoints(DAILY_REWARD_AMOUNT), inline: true },
      )
      .setFooter({ text: "출석 보상은 한국 시간 기준 하루 1번 받을 수 있습니다." });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  const newBalance = addUserPoints(guildId, userId, DAILY_REWARD_AMOUNT);
  record.daily.lastClaimDate = todayKey;
  record.daily.claims += 1;
  record.daily.totalClaimed += DAILY_REWARD_AMOUNT;
  record.updatedAt = new Date().toISOString();
  saveGambleData();

  const embed = buildBaseEmbed(interaction, "출석 보상 지급", 0x2ecc71)
    .setDescription("오늘의 지원금이 지급되었습니다.")
    .addFields(
      { name: "지급 금액", value: formatPoints(DAILY_REWARD_AMOUNT), inline: true },
      { name: "현재 잔액", value: formatPoints(newBalance), inline: true },
      { name: "누적 출석", value: `${record.daily.claims.toLocaleString("ko-KR")}회`, inline: true },
      { name: "누적 지급", value: formatPoints(record.daily.totalClaimed), inline: true },
    )
    .setFooter({ text: "출석 보상은 한국 시간 기준 하루 1번 받을 수 있습니다." });

  await interaction.reply({ embeds: [embed] });
}

async function handleLotteryCommand(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const count = interaction.options.getInteger("개수") || 1;
  const totalCost = count * LOTTERY_TICKET_PRICE;
  const userStats = getUserStats(guildId, userId);
  const balance = Number(userStats.points) || 0;

  if (totalCost > balance) {
    await replyError(interaction, `복권 구매 포인트가 부족합니다. 필요: ${formatPoints(totalCost)} / 현재: ${formatPoints(balance)}`);
    return;
  }

  const draws = Array.from({ length: count }, drawLotteryTicket);
  const totalPrize = draws.reduce((sum, draw) => sum + draw.multiplier * LOTTERY_TICKET_PRICE, 0);
  const delta = totalPrize - totalCost;
  const newBalance = addUserPoints(guildId, userId, delta);
  const record = getGambleStats(guildId, userId);

  record.lottery.tickets += count;
  record.lottery.spent += totalCost;
  record.lottery.prize += totalPrize;
  record.lottery.profit += delta;
  record.lottery.wins += draws.filter((draw) => draw.multiplier > 0).length;
  record.lottery.jackpots += draws.filter((draw) => draw.label === "잭팟").length;
  record.lottery.bestPrize = Math.max(record.lottery.bestPrize, ...draws.map((draw) => draw.multiplier * LOTTERY_TICKET_PRICE));
  record.updatedAt = new Date().toISOString();
  saveGambleData();

  const resultText = draws
    .map((draw, index) => `${index + 1}. ${draw.label} (${formatPoints(draw.multiplier * LOTTERY_TICKET_PRICE)})`)
    .join("\n");
  const bestColor = draws.reduce((color, draw) => (draw.multiplier > 0 ? draw.color : color), 0x95a5a6);

  const embed = buildBaseEmbed(interaction, totalPrize > 0 ? "복권 당첨 결과" : "복권 결과", bestColor)
    .setDescription(resultText)
    .addFields(
      { name: "구매 금액", value: formatPoints(totalCost), inline: true },
      { name: "당첨금", value: formatPoints(totalPrize), inline: true },
      { name: "이번 손익", value: formatPoints(delta), inline: true },
      { name: "현재 잔액", value: formatPoints(newBalance), inline: true },
      { name: "누적 복권 손익", value: formatPoints(record.lottery.profit), inline: true },
      { name: "누적 잭팟", value: `${record.lottery.jackpots}회`, inline: true },
    )
    .setFooter({ text: `복권 1장 ${formatPoints(LOTTERY_TICKET_PRICE)} / 잭팟 1%, 대박 4%, 당첨 15%` });

  await interaction.reply({ embeds: [embed] });
}

async function handleAssetsCommand(interaction) {
  const guildId = interaction.guildId;
  const targetUser = interaction.options.getUser("대상") || interaction.user;

  if (targetUser.bot) {
    await replyError(interaction, "봇의 자산은 조회할 수 없습니다.");
    return;
  }

  const userStats = getUserStats(guildId, targetUser.id);
  const record = getGambleStats(guildId, targetUser.id);
  const gamblingWinRate = record.gambling.plays > 0
    ? Math.round((record.gambling.wins / record.gambling.plays) * 100)
    : 0;

  const embed = buildBaseEmbed(interaction, "포인트 자산", 0xf1c40f, targetUser)
    .setDescription(`<@${targetUser.id}>님의 포인트 현황입니다.`)
    .addFields(
      { name: "보유 포인트", value: formatPoints(userStats.points), inline: true },
      { name: "출석", value: `${record.daily.claims.toLocaleString("ko-KR")}회`, inline: true },
      { name: "출석 누적 지급", value: formatPoints(record.daily.totalClaimed), inline: true },
      { name: "도박 전적", value: `${record.gambling.wins}승 ${record.gambling.losses}패 (${gamblingWinRate}%)`, inline: true },
      { name: "도박 누적 손익", value: formatPoints(record.gambling.profit), inline: true },
      { name: "도박 최고 수익", value: formatPoints(record.gambling.bestWin), inline: true },
      { name: "복권 구매", value: `${record.lottery.tickets.toLocaleString("ko-KR")}장`, inline: true },
      { name: "복권 누적 손익", value: formatPoints(record.lottery.profit), inline: true },
      { name: "잭팟", value: `${record.lottery.jackpots.toLocaleString("ko-KR")}회`, inline: true },
    )
    .setFooter({ text: "포인트는 도박, 복권, 출석, 송금에 함께 사용됩니다." });

  await interaction.reply({ embeds: [embed] });
}

async function handleTransferCommand(interaction) {
  const guildId = interaction.guildId;
  const sender = interaction.user;
  const targetUser = interaction.options.getUser("대상", true);
  const amount = interaction.options.getInteger("금액", true);
  const senderStats = getUserStats(guildId, sender.id);
  const targetStats = getUserStats(guildId, targetUser.id);
  const senderBalance = Number(senderStats.points) || 0;

  if (targetUser.id === sender.id) {
    await replyError(interaction, "자기 자신에게는 송금할 수 없습니다.");
    return;
  }

  if (targetUser.bot) {
    await replyError(interaction, "봇에게는 송금할 수 없습니다.");
    return;
  }

  if (senderStats.admin === true || targetStats.admin === true) {
    await replyError(interaction, "어드민 계정은 송금에 참여할 수 없습니다.");
    return;
  }

  if (amount > senderBalance) {
    await replyError(interaction, `보유 포인트가 부족합니다. 현재 잔액: ${formatPoints(senderBalance)}`);
    return;
  }

  const senderNewBalance = addUserPoints(guildId, sender.id, -amount);
  const targetNewBalance = addUserPoints(guildId, targetUser.id, amount);

  logActionAudit({
    phase: "success",
    action: "points.transfer",
    guildId,
    userId: sender.id,
    targetUserId: targetUser.id,
    amount,
  });

  const embed = buildBaseEmbed(interaction, "포인트 송금 완료", 0x2ecc71)
    .setDescription(`<@${sender.id}>님이 <@${targetUser.id}>님에게 포인트를 보냈습니다.`)
    .addFields(
      { name: "송금 금액", value: formatPoints(amount), inline: true },
      { name: "내 잔액", value: formatPoints(senderNewBalance), inline: true },
      { name: "상대 잔액", value: formatPoints(targetNewBalance), inline: true },
    );

  await interaction.reply({ embeds: [embed] });
}

async function handleGambleInteraction(interaction) {
  if (interaction.commandName === "도박") {
    await handleGambleCommand(interaction);
    return true;
  }

  if (interaction.commandName === "출석") {
    await handleDailyCommand(interaction);
    return true;
  }

  if (interaction.commandName === "복권") {
    await handleLotteryCommand(interaction);
    return true;
  }

  if (interaction.commandName === "자산") {
    await handleAssetsCommand(interaction);
    return true;
  }

  if (interaction.commandName === "송금") {
    await handleTransferCommand(interaction);
    return true;
  }

  return false;
}

loadGambleData();

export { GAMBLE_COMMANDS, handleGambleInteraction };
