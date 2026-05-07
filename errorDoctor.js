import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LOG_FILE_PATH } from "./config.js";
import { callModel } from "./ai.js";

const execFileAsync = promisify(execFile);

const LOG_DIR = path.dirname(path.resolve(process.cwd(), LOG_FILE_PATH));
const ERROR_MARK_FILE = path.resolve(LOG_DIR, "error-marks.jsonl");
const REPAIR_DIR = path.resolve(LOG_DIR, "error-repair");
const MAX_TAIL_BYTES = 140_000;
const MAX_COMMAND_OUTPUT = 8_000;
const CONTEXT_RADIUS = 18;
const CODE_FILES = [
  "index.js",
  "actions.js",
  "handlers.js",
  "ai.js",
  "commands.js",
  "database.js",
  "logger.js",
  "scheduler.js",
  "space.js",
  "typing.js",
  "utils.js",
];

function truncate(text, max = MAX_COMMAND_OUTPUT) {
  const input = String(text || "");
  if (input.length <= max) return input;
  return `${input.slice(0, max)}\n... truncated ...`;
}

function readTail(filePath, maxBytes = MAX_TAIL_BYTES) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function parseJsonl(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function extractStackReferences(errorMarks) {
  const refs = [];
  const seen = new Set();
  for (const mark of errorMarks) {
    const stack = String(mark.stack || "");
    const matches = stack.matchAll(/\(?([A-Za-z0-9_.\-\\/]+\.js):(\d+):(\d+)\)?/g);
    for (const match of matches) {
      const relPath = match[1].replace(/\\/g, "/").split("/").slice(-1)[0];
      const line = Number(match[2]);
      if (!relPath || !Number.isInteger(line)) continue;
      const key = `${relPath}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ path: relPath, line });
    }
  }
  return refs.slice(0, 10);
}

function readCodeWindow(relPath, line) {
  const filePath = path.resolve(process.cwd(), relPath);
  if (!filePath.startsWith(process.cwd()) || !fs.existsSync(filePath)) return "";
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    const start = Math.max(0, Number(line) - CONTEXT_RADIUS - 1);
    const end = Math.min(lines.length, Number(line) + CONTEXT_RADIUS);
    return lines
      .slice(start, end)
      .map((value, idx) => `${start + idx + 1}: ${value}`)
      .join("\n");
  } catch {
    return "";
  }
}

async function runCommand(label, command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: process.cwd(),
      timeout: options.timeoutMs || 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return {
      label,
      ok: true,
      command: [command, ...args].join(" "),
      output: truncate(`${result.stdout || ""}${result.stderr || ""}`.trim() || "(no output)"),
    };
  } catch (error) {
    return {
      label,
      ok: false,
      command: [command, ...args].join(" "),
      output: truncate(`${error.stdout || ""}${error.stderr || ""}${error.message ? `\n${error.message}` : ""}`.trim()),
    };
  }
}

async function runDiagnostics() {
  const commands = [
    runCommand("git status", "git", ["status", "--short"]),
  ];

  for (const file of CODE_FILES) {
    if (fs.existsSync(path.resolve(process.cwd(), file))) {
      commands.push(runCommand(`syntax ${file}`, process.execPath, ["--check", file]));
    }
  }

  return Promise.all(commands);
}

function normalizeModelText(raw) {
  const text = typeof raw === "string" ? raw : String(raw?.text || "");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // The model is usually in JSON mode, but keep a plain-text fallback.
  }
  return {
    summary: text || "분석 결과를 파싱하지 못했습니다.",
    suspectedCause: "",
    proposedFix: "",
    fileEdits: [],
    verificationCommands: [],
  };
}

function buildAnalysisPrompt({ recentErrors, readableLogTail, eventLogTail, codeContext, diagnostics }) {
  return `
당신은 Node.js Discord 봇의 오류 분석 및 최소 수정 제안 도우미입니다.
아래 로그, 오류 마킹, 코드 주변부, child_process 진단 결과를 보고 원인을 분석하세요.

반드시 JSON 객체 하나만 출력하세요.
형식:
{
  "summary":"최고 관리자에게 보여줄 짧은 한국어 요약",
  "suspectedCause":"가장 그럴듯한 원인",
  "evidence":["근거 1","근거 2"],
  "proposedFix":"수정 방향",
  "risk":"low|medium|high",
  "fileEdits":[
    {
      "path":"index.js",
      "find":"파일 안에서 정확히 한 번만 존재하는 원문",
      "replace":"대체할 내용",
      "reason":"수정 이유"
    }
  ],
  "verificationCommands":[["node","--check","index.js"]]
}

규칙:
- 확신이 없으면 fileEdits는 빈 배열로 두세요.
- find는 반드시 제공된 코드에 실제로 보이는 짧고 고유한 문자열이어야 합니다.
- 로그/설정/DB/node_modules/package-lock.json은 수정 대상으로 제안하지 마세요.
- 위험도가 높거나 데이터 손실 가능성이 있으면 fileEdits를 비우고 설명만 하세요.

최근 오류 마킹:
${JSON.stringify(recentErrors, null, 2)}

읽기용 로그 tail:
${readableLogTail || "(empty)"}

JSONL 이벤트 로그 tail:
${eventLogTail || "(empty)"}

코드 주변부:
${codeContext || "(no stack code references)"}

child_process 진단:
${JSON.stringify(diagnostics, null, 2)}
`;
}

function formatAnalysisForDiscord(analysis, recentErrors) {
  const latest = recentErrors[0];
  const fileEditCount = Array.isArray(analysis.fileEdits) ? analysis.fileEdits.length : 0;
  const evidence = Array.isArray(analysis.evidence) ? analysis.evidence.slice(0, 3) : [];
  const lines = [
    "오류 분석 결과입니다.",
    latest ? `최근 마킹: ${latest.atKst || latest.at} / 서버: ${latest.guildName || latest.guildId || "unknown"} / scope: ${latest.scope}` : "최근 마킹: 없음",
    "",
    `요약: ${analysis.summary || "요약 없음"}`,
    analysis.suspectedCause ? `추정 원인: ${analysis.suspectedCause}` : "",
    analysis.proposedFix ? `수정 방향: ${analysis.proposedFix}` : "",
    `위험도: ${analysis.risk || "unknown"}`,
    evidence.length ? `근거:\n${evidence.map((item) => `- ${item}`).join("\n")}` : "",
    "",
    fileEditCount > 0
      ? `수정 후보 ${fileEditCount}개가 있습니다. 적용을 시도하려면 60초 안에 ✅ 또는 "응"으로 확인해 주세요.`
      : "자동 적용할 만큼 확실한 수정 후보는 없습니다. 로그와 코드 근거만 정리했습니다.",
  ];
  return lines.filter(Boolean).join("\n");
}

export async function analyzeLatestErrors(options = {}) {
  const recentErrors = parseJsonl(readTail(ERROR_MARK_FILE))
    .reverse()
    .filter((mark) => !options.guildId || !mark.guildId || mark.guildId === options.guildId)
    .slice(0, 8);
  const readableLogTail = truncate(readTail(path.resolve(LOG_DIR, "bot-events.log"), 50_000), 12_000);
  const eventLogTail = truncate(readTail(path.resolve(LOG_DIR, "bot-events.jsonl"), 50_000), 12_000);
  const diagnostics = await runDiagnostics();
  const stackRefs = extractStackReferences(recentErrors);
  const codeContext = stackRefs
    .map((ref) => `FILE ${ref.path}:${ref.line}\n${readCodeWindow(ref.path, ref.line)}`)
    .filter((value) => value.trim())
    .join("\n\n");

  if (recentErrors.length === 0) {
    return {
      message: "최근 오류 마킹이 없습니다. 새 오류가 발생하면 서버와 시간이 `logs/error-marks.jsonl`에 기록됩니다.",
      analysis: null,
      diagnostics,
    };
  }

  const raw = await callModel(buildAnalysisPrompt({
    recentErrors,
    readableLogTail,
    eventLogTail,
    codeContext,
    diagnostics,
  }));
  const analysis = normalizeModelText(raw);
  return {
    message: formatAnalysisForDiscord(analysis, recentErrors),
    analysis,
    diagnostics,
  };
}

export async function attemptErrorRepair(analysis) {
  fs.mkdirSync(REPAIR_DIR, { recursive: true });
  const requestPath = path.resolve(REPAIR_DIR, `repair-${Date.now()}.json`);
  fs.writeFileSync(requestPath, JSON.stringify({ analysis }, null, 2), "utf8");

  const result = await runCommand(
    "apply proposed repair",
    process.execPath,
    ["scripts/error_repair_attempt.js", requestPath],
    { timeoutMs: 30_000 },
  );
  const diagnostics = await runDiagnostics();
  const failed = diagnostics.filter((item) => !item.ok);
  const summary = [
    result.ok ? "수정 시도 프로세스가 완료되었습니다." : "수정 시도 프로세스가 실패했습니다.",
    "",
    "적용 결과:",
    result.output,
    "",
    failed.length === 0
      ? "검증: child_process 진단이 모두 통과했습니다."
      : `검증: 실패 ${failed.length}개\n${failed.map((item) => `- ${item.label}: ${item.output.split("\n")[0]}`).join("\n")}`,
  ].join("\n");

  return { ok: result.ok && failed.length === 0, message: truncate(summary, 1800), diagnostics };
}
