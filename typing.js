import { AttachmentBuilder, PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from "discord.js";
import { Resvg } from "@resvg/resvg-js";
import { PREFIX } from "./config.js";
import { callModel } from "./ai.js";
import { logError } from "./logger.js";
import { safeParseJsonObject } from "./utils.js";

const typingGamesByChannel = new Map();
const typingLeaderboard = new Map();

const TYPING_COMMANDS = [
  new SlashCommandBuilder()
    .setName("타자연습")
    .setDescription("타자 게임 명령어")
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("새 타자 게임을 시작합니다.")
        .addStringOption((opt) =>
          opt
            .setName("mode")
            .setDescription("게임 모드")
            .setRequired(true)
            .addChoices(
              { name: "solo (혼자)", value: "solo" },
              { name: "ranked (순위전)", value: "ranked" },
            ),
        )
        .addStringOption((opt) =>
          opt
            .setName("length")
            .setDescription("문장 길이")
            .setRequired(true)
            .addChoices(
              { name: "short (단문)", value: "short" },
              { name: "long (장문)", value: "long" },
            ),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("time_limit")
            .setDescription("제한 시간(초)")
            .setRequired(false)
            .addChoices(
              { name: "30초", value: 30 },
              { name: "60초", value: 60 },
              { name: "90초", value: 90 },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName("stop").setDescription("현재 채널의 타자 게임을 강제 종료합니다."))
    .addSubcommand((sub) => sub.setName("leaderboard").setDescription("누적 순위를 확인합니다.")),
].map((cmd) => cmd.toJSON());

const FALLBACK_SENTENCES = {
  short: [
    "오늘도 정확한 타자로 기록을 경신해 보세요.",
    "실수 없이 끝까지 침착하게 입력해 주세요.",
    "짧은 문장도 리듬을 타면 더 빨라집니다.",
  ],
  long: [
    "빠른 손보다 중요한 것은 안정적인 호흡이며, 정확도를 유지하면 결국 속도도 자연스럽게 따라옵니다.",
    "순간적인 스퍼트보다 끝까지 일정한 리듬을 지키는 플레이가 랭크 게임에서 더 높은 점수를 만듭니다.",
    "문장을 눈으로 한 번 더 확인하고 입력하면 오타를 줄일 수 있고, 결과적으로 평균 속도 또한 꾸준히 상승합니다.",
  ],
};

function sampleFallbackSentence(lengthMode) {
  const pool = FALLBACK_SENTENCES[lengthMode] || FALLBACK_SENTENCES.short;
  return pool[Math.floor(Math.random() * pool.length)];
}

function normalizeTypingText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeTypingForMatch(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}

function calcWpm(chars, elapsedMs) {
  const minutes = Math.max(elapsedMs / 60000, 1 / 60000);
  return Math.max(0, Math.round((chars / 5) / minutes));
}

function awardRankPoints(place) {
  if (place === 1) return 5;
  if (place === 2) return 3;
  if (place === 3) return 2;
  return 1;
}

function updateLeaderboardEntry(userId, username, place, wpm) {
  const prev = typingLeaderboard.get(userId) || {
    userId,
    username,
    points: 0,
    games: 0,
    wins: 0,
    bestWpm: 0,
  };

  prev.username = username || prev.username;
  prev.games += 1;
  prev.bestWpm = Math.max(prev.bestWpm, wpm);
  prev.points += awardRankPoints(place);
  if (place === 1) prev.wins += 1;
  typingLeaderboard.set(userId, prev);
}

async function generateTypingSentence(lengthMode) {
  const sentenceType = lengthMode === "long" ? "장문" : "단문";
  const prompt = `
너는 타자 게임 문장 생성기다.
반드시 JSON 객체 하나만 출력한다.
형식: {"sentence":"..."}
조건:
- 한국어 ${sentenceType} 1개
- 욕설/혐오/정치 선동/개인정보 없음
- 따옴표는 사용하지 않음
- ${lengthMode === "long" ? "90~150자" : "25~55자"}
- 읽기 쉬운 자연스러운 문장
`;

  try {
    const raw = await callModel(prompt);
    const parsed = safeParseJsonObject(raw);
    const sentence = normalizeTypingText(parsed?.sentence);
    if (sentence) return sentence;
  } catch {
    // fall through to fallback
  }

  return sampleFallbackSentence(lengthMode);
}

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapByLength(text, maxLen = 22) {
  const normalized = normalizeTypingText(text);
  const lines = [];
  let chunk = "";

  for (const ch of normalized) {
    if ((chunk + ch).length > maxLen) {
      lines.push(chunk);
      chunk = ch;
      continue;
    }
    chunk += ch;
  }

  if (chunk) lines.push(chunk);
  return lines.slice(0, 5);
}

function buildSentenceImage(sentence) {
  const lines = wrapByLength(sentence, 16);
  const width = 1280;
  const height = 620;
  const lineHeight = 92;
  const baseY = 280;
  const lineSvg = lines
    .map((line, idx) => {
      const y = baseY + (idx * lineHeight);
      return `<text x="640" y="${y}" text-anchor="middle" class="sentence" font-size="72" font-weight="800">${escapeXml(line)}</text>`;
    })
    .join("\n");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#1e293b" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)" />
  <rect x="32" y="32" width="1216" height="556" rx="24" fill="#0b1220" stroke="#334155" stroke-width="2" />
  <text x="640" y="118" text-anchor="middle" class="title" font-size="52" font-weight="700">TYPE THIS SENTENCE</text>
  <text x="640" y="178" text-anchor="middle" class="sub" font-size="34" font-weight="600">복사 방지를 위해 이미지로 제공됩니다</text>
  ${lineSvg}
  <style>
    .title { fill: #93c5fd; font-family: 'Malgun Gothic', sans-serif; letter-spacing: 1px; }
    .sub { fill: #cbd5e1; font-family: 'Malgun Gothic', sans-serif; }
    .sentence { fill: #f8fafc; font-family: 'Malgun Gothic', sans-serif; }
  </style>
</svg>`;

  try {
    const resvg = new Resvg(svg, {
      fitTo: {
        mode: "width",
        value: 1280,
      },
    });
    const pngData = resvg.render();
    return { buffer: pngData.asPng(), name: "typing-sentence.png" };
  } catch {
    return { buffer: Buffer.from(svg, "utf8"), name: "typing-sentence.svg" };
  }
}

async function finishTypingGame(channel, game, reason = "timeout") {
  if (!typingGamesByChannel.has(channel.id)) return;

  if (game.timeoutHandle) clearTimeout(game.timeoutHandle);
  typingGamesByChannel.delete(channel.id);

  if (game.mode === "solo") {
    if (game.results.length > 0) return;
    await channel.send(`시간이 종료되었습니다. 정답 문장: \`${game.sentence}\``);
    return;
  }

  if (reason === "manual_stop") {
    await channel.send("랭크 게임이 중지되었습니다.");
    return;
  }

  if (game.results.length === 0) {
    await channel.send(`시간이 종료되었습니다. 제출자가 없어 순위가 집계되지 않았습니다.\n정답 문장: \`${game.sentence}\``);
    return;
  }

  const rankingLines = game.results
    .sort((a, b) => a.elapsedMs - b.elapsedMs)
    .map((row, index) => `${index + 1}위 <@${row.userId}> - ${row.wpm} WPM (${(row.elapsedMs / 1000).toFixed(2)}초)`);

  game.results.forEach((row, index) => {
    updateLeaderboardEntry(row.userId, row.username, index + 1, row.wpm);
  });

  await channel.send(`랭크 게임 종료!\n${rankingLines.join("\n")}`);
}

async function tryHandleTypingGameSubmission(message) {
  const game = typingGamesByChannel.get(message.channel.id);
  if (!game) return false;

  const normalized = normalizeTypingForMatch(message.content);
  if (normalized !== game.sentenceMatchKey) return false;

  const elapsedMs = Date.now() - game.startedAt;
  const wpm = calcWpm(game.sentence.length, elapsedMs);

  if (game.mode === "solo") {
    if (message.author.id !== game.hostUserId) return true;

    game.results.push({ userId: message.author.id, username: message.author.username, elapsedMs, wpm });
    if (game.timeoutHandle) clearTimeout(game.timeoutHandle);
    typingGamesByChannel.delete(message.channel.id);
    await message.reply(`완료! ${(elapsedMs / 1000).toFixed(2)}초 / ${wpm} WPM`);
    return true;
  }

  if (game.participants.has(message.author.id)) return true;

  game.participants.add(message.author.id);
  game.results.push({ userId: message.author.id, username: message.author.username, elapsedMs, wpm });
  await message.reply(`${game.results.length}위 기록! ${wpm} WPM`);

  if (game.results.length >= 10) {
    await finishTypingGame(message.channel, game, "max_participants");
  }
  return true;
}

function renderLeaderboardText() {
  const rows = [...typingLeaderboard.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.bestWpm - a.bestWpm;
  });

  if (rows.length === 0) {
    return "아직 순위 데이터가 없습니다. `/타자연습 start mode:ranked`로 시작해 보세요.";
  }

  return rows
    .slice(0, 10)
    .map((row, idx) => `${idx + 1}위 <@${row.userId}> | 점수 ${row.points} | 1위 ${row.wins}회 | 최고 ${row.bestWpm} WPM`)
    .join("\n");
}

async function handleTypingInteraction(interaction) {
  const sub = interaction.options.getSubcommand();

  try {
    if (sub === "leaderboard") {
      await interaction.reply({ content: `타자 게임 누적 순위\n${renderLeaderboardText()}` });
      return;
    }

    if (sub === "stop") {
      const active = typingGamesByChannel.get(interaction.channelId);
      if (!active) {
        await interaction.reply({ content: "현재 채널에는 진행 중인 타자 게임이 없습니다.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (active.hostUserId !== interaction.user.id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply({ content: "게임을 중지할 권한이 없습니다.", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.reply({ content: "진행 중인 타자 게임을 중지합니다." });
      await finishTypingGame(interaction.channel, active, "manual_stop");
      return;
    }

    if (sub === "start") {
      if (typingGamesByChannel.has(interaction.channelId)) {
        await interaction.reply({ content: "이 채널에는 이미 진행 중인 타자 게임이 있습니다. `/타자연습 stop`으로 종료 후 다시 시작해 주세요.", flags: MessageFlags.Ephemeral });
        return;
      }

      const mode = interaction.options.getString("mode", true);
      const length = interaction.options.getString("length", true);
      const timeLimit = interaction.options.getInteger("time_limit") || (mode === "ranked" ? 60 : 90);

      await interaction.deferReply();

      const sentence = await generateTypingSentence(length);
      const now = Date.now();
      const game = {
        mode,
        length,
        sentence,
        sentenceNormalized: normalizeTypingText(sentence),
        sentenceMatchKey: normalizeTypingForMatch(sentence),
        hostUserId: interaction.user.id,
        startedAt: now,
        participants: new Set(),
        results: [],
        timeoutHandle: null,
      };

      game.timeoutHandle = setTimeout(() => {
        finishTypingGame(interaction.channel, game, "timeout").catch((err) => {
          logError("typingGame.timeout", err, {
            guildId: interaction.guildId || null,
            channelId: interaction.channelId,
            userId: interaction.user.id,
          });
        });
      }, timeLimit * 1000);

      typingGamesByChannel.set(interaction.channelId, game);

      const modeName = mode === "ranked" ? "순위전" : "솔로";
      const lengthName = length === "long" ? "장문" : "단문";
      const extra = mode === "ranked"
        ? "먼저 정확히 입력한 순서대로 순위가 기록됩니다."
        : "개설한 본인만 기록됩니다.";

      const image = buildSentenceImage(sentence);
      const sentenceImage = new AttachmentBuilder(image.buffer, { name: image.name });

      await interaction.editReply({
        content: `타자 게임 시작!\n모드: ${modeName} | 길이: ${lengthName} | 제한: ${timeLimit}초\n${extra}\n판정 기준: 줄바꿈/띄어쓰기는 무시됩니다.`,
        files: [sentenceImage],
      });
      return;
    }

    await interaction.reply({ content: "지원하지 않는 하위 명령입니다.", flags: MessageFlags.Ephemeral });
  } catch (err) {
    logError("interactionCreate.typing", err, {
      guildId: interaction.guildId || null,
      channelId: interaction.channelId || null,
      userId: interaction.user?.id || null,
      subcommand: sub,
    });

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply("타자 게임 처리 중 오류가 발생했습니다.");
    } else {
      await interaction.reply({ content: "타자 게임 처리 중 오류가 발생했습니다.", flags: MessageFlags.Ephemeral });
    }
  }
}

export { TYPING_COMMANDS, tryHandleTypingGameSubmission, handleTypingInteraction };
