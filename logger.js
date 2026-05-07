import fs from "node:fs";
import path from "node:path";
import { LOG_FILE_PATH } from "./config.js";

const resolvedLogFilePath = path.resolve(process.cwd(), LOG_FILE_PATH);
const resolvedLogDir = path.dirname(resolvedLogFilePath);
const resolvedErrorMarkPath = path.resolve(resolvedLogDir, "error-marks.jsonl");

function ensureLogDir() {
  try {
    fs.mkdirSync(resolvedLogDir, { recursive: true });
  } catch (error) {
    console.error("[error] failed to create log dir", error);
  }
}

// 긴 텍스트를 지정된 길이로 자르는 유틸리티 함수
function truncateText(text, maxLength = 100) {
  if (!text || typeof text !== 'string') return text;
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

// 콘솔에 구조화된 로그를 출력하는 함수
function logToConsole(level, scope, meta = {}) {
  const timestamp = new Date().toLocaleTimeString();
  const levelEmoji = {
    info: 'ℹ️',
    warn: '⚠️',
    error: '❌',
    debug: '🔍'
  }[level] || '📝';

  const scopeColor = {
    'command.trigger': '\x1b[36m', // Cyan
    'action.audit': '\x1b[32m',    // Green
    'ai.call': '\x1b[35m',        // Magenta
    'error': '\x1b[31m'           // Red
  }[scope] || '\x1b[37m';         // White

  const resetColor = '\x1b[0m';

  // 기본 정보 출력
  let logLine = `${levelEmoji} [${timestamp}] ${scopeColor}${scope}${resetColor}`;

  // 중요한 메타데이터 추가
  if (meta.guildName) logLine += ` (${meta.guildName})`;
  if (meta.username) logLine += ` ${meta.username}`;
  if (meta.action) logLine += ` ${meta.action}`;
  if (meta.phase) logLine += ` [${meta.phase}]`;

  console.log(logLine);

  // 긴 텍스트는 별도로 출력
  if (meta.commandText) {
    console.log(`   명령어: ${truncateText(meta.commandText, 80)}`);
  }
  if (meta.message && meta.message.length > 50) {
    console.log(`   메시지: ${truncateText(meta.message, 80)}`);
  }
  if (meta.error && level === 'error') {
    console.log(`   에러: ${truncateText(meta.error, 80)}`);
  }
}

function writeEvent(level, scope, meta = {}) {
  ensureLogDir();

  // JSON 파일에는 모든 상세 정보 기록
  const payload = {
    at: new Date().toISOString(),
    level,
    scope,
    ...meta,
  };

  fs.appendFile(resolvedLogFilePath, `${JSON.stringify(payload)}\n`, "utf8", (error) => {
    if (error) {
      console.error("[error] failed to append log file", error);
    }
  });

  // 사람이 읽기 쉬운 텍스트 로그 파일도 생성
  writeReadableLog(level, scope, meta);

  // 콘솔에 구조화된 로그 출력 (에러는 이미 출력됨)
  // action.audit의 attempt 단계는 콘솔에서 숨겨 중복 실행처럼 보이는 혼란을 줄입니다.
  const shouldPrintConsole = !(
    scope === "action.audit" &&
    String(meta.phase || "").toLowerCase() === "attempt"
  );

  if (level !== "error" && shouldPrintConsole) {
    logToConsole(level, scope, meta);
  }
}

function formatKstTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function writeErrorMark(scope, err, meta = {}) {
  ensureLogDir();

  const payload = {
    at: new Date().toISOString(),
    atKst: formatKstTimestamp(),
    scope,
    guildId: meta.guildId || null,
    guildName: meta.guildName || null,
    channelId: meta.channelId || null,
    channelName: meta.channelName || null,
    userId: meta.userId || null,
    message: err.message,
    stack: err.stack,
  };

  fs.appendFile(resolvedErrorMarkPath, `${JSON.stringify(payload)}\n`, "utf8", (error) => {
    if (error) {
      console.error("[error] failed to append error mark file", error);
    }
  });
}

// 사람이 읽기 쉬운 로그 파일 작성 함수
function writeReadableLog(level, scope, meta = {}) {
  const readableLogPath = resolvedLogFilePath.replace('.jsonl', '.log');
  const timestamp = new Date().toLocaleString();

  let logLine = `[${timestamp}] ${level.toUpperCase()} ${scope}`;

  // 중요한 정보들만 추출해서 읽기 쉽게 표시
  const importantFields = [];

  if (meta.guildName) importantFields.push(`서버: ${meta.guildName}`);
  if (meta.username) importantFields.push(`사용자: ${meta.username}`);
  if (meta.action) importantFields.push(`액션: ${meta.action}`);
  if (meta.commandText) importantFields.push(`명령어: ${truncateText(meta.commandText, 50)}`);
  if (meta.phase) importantFields.push(`단계: ${meta.phase}`);
  if (meta.reason) importantFields.push(`사유: ${meta.reason}`);

  if (importantFields.length > 0) {
    logLine += ` | ${importantFields.join(' | ')}`;
  }

  // 긴 메시지는 다음 줄에 표시
  const additionalLines = [];
  if (meta.message && meta.message.length > 80) {
    additionalLines.push(`  메시지: ${truncateText(meta.message, 100)}`);
  }
  if (meta.error) {
    additionalLines.push(`  에러: ${truncateText(meta.error, 100)}`);
  }

  const combined = additionalLines.length > 0
    ? `${logLine}\n${additionalLines.join('\n')}\n`
    : `${logLine}\n`;

  fs.appendFile(readableLogPath, combined, "utf8", (error) => {
    if (error) {
      console.error("[error] failed to append readable log file", error);
    }
  });
}

export function logError(scope, error, meta = {}) {
  const err = error instanceof Error ? error : new Error(String(error));
  const errorMeta = {
    message: err.message,
    stack: err.stack,
    error: err.message,
    ...meta,
  };

  // 콘솔에 에러 로그 출력
  logToConsole("error", scope, errorMeta);

  writeErrorMark(scope, err, errorMeta);
  writeEvent("error", scope, errorMeta);
}

export function logCommandTrigger(message, commandText) {
  const guildName = message.guild?.name || "DM";
  writeEvent("info", "command.trigger", {
    shardId: message.guild?.shardId ?? message.client?.shard?.ids?.[0] ?? 0,
    guildId: message.guild?.id || null,
    guildName,
    channelId: message.channel?.id || null,
    channelName: "name" in (message.channel || {}) ? message.channel.name || null : null,
    userId: message.author?.id || null,
    username: message.author?.tag || message.author?.username || null,
    commandText,
  });
  // console.log는 이제 writeEvent 내부에서 처리됨
}

export function logActionAudit(meta = {}) {
  writeEvent("info", "action.audit", meta);
}

export function logAiCall(modelName, prompt, response = null, success = true, error = null) {
  const errorMessage = error?.message ? truncateText(String(error.message), 200) : null;
  const errorStatus = error?.status ?? null;
  const errorCause = error?.cause?.code ? String(error.cause.code) : null;

  writeEvent("info", "ai.call", {
    modelName,
    promptLength: prompt?.length || 0,
    responseLength: response?.length || 0,
    success,
    prompt: truncateText(prompt, 200), // 프롬프트 일부만 기록
    response: response ? truncateText(response, 200) : null, // 응답 일부만 기록
    errorMessage,
    errorStatus,
    errorCause,
  });
}
