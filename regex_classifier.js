// 명령/의도 판별: 동기 정규식 우선, 필요 시에만 AI 보조
import { callModel } from "./ai.js";
import { safeParseJsonObject } from "./utils.js";
import { REGION_MAP } from "./weather.js";

// 1. reset-memory 명령어 판단
export async function detectResetMemoryCommand(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return { isReset: false, argsText: "" };

  const directMatch = normalized.match(/^!reset[_-]memory\b\s*(.*)$/i);
  if (directMatch) {
    return { isReset: true, argsText: String(directMatch[1] || "").trim() };
  }

  const prompt = `당신은 Discord 봇 명령어 파서입니다.
아래 메시지가 !reset-memory 명령어인지 판단하세요.

규칙:
- !reset-memory 또는 !reset_memory로 시작하면 true
- 그 외는 false
- argsText는 명령어 뒤의 모든 텍스트 (있으면)

출력: {"isReset":true|false,"argsText":"텍스트"}

메시지: "${normalized}"`;

  try {
    const result = await callModel(prompt);
    const parsed = safeParseJsonObject(result);
    if (parsed && typeof parsed.isReset === "boolean") {
      return { isReset: parsed.isReset, argsText: String(parsed.argsText || "").trim() };
    }
  } catch {
    // ignore
  }

  return { isReset: false, argsText: "" };
}

// 2. 함수 서명 감지 (줄 번호, 1-based; 없으면 -1)
export async function detectFunctionSignature(source, functionName) {
  const lines = String(source || "").split("\n");
  const escapedName = String(functionName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const signatureRegex = new RegExp(
    `^(?:export\\s+)?(?:async\\s+)?(?:function\\s+${escapedName}|(?:const|let|var)\\s+${escapedName}\\s*=|${escapedName}\\s*=\\s*\\(?)(?:.*)$`,
    "i",
  );
  const idx = lines.findIndex((line) => signatureRegex.test(line.trim()));
  if (idx >= 0) return idx + 1;

  const prompt = `당신은 JavaScript 코드 분석기입니다.
아래 코드에서 "${functionName}"이라는 함수의 시작 줄번호를 찾으세요.

규칙:
- function ${functionName} 또는
- const/let/var ${functionName} = 또는
- 이들 변형 찾기
- 없으면 -1

코드:
\`\`\`js
${String(source || "").slice(0, 8000)}
\`\`\`

출력: {"lineNumber":숫자}`;

  try {
    const result = await callModel(prompt);
    const parsed = safeParseJsonObject(result);
    if (parsed && typeof parsed.lineNumber === "number") {
      return parsed.lineNumber;
    }
  } catch {
    // ignore
  }
  return -1;
}

// 3. 모델 트리거 감지
export async function detectModelTrigger(text) {
  const normalized = String(text || "");
  if (/모델|호출|테스트|model|call/i.test(normalized)) {
    return true;
  }

  const prompt = `당신은 사용자 메시지에서 AI 모델 호출 의도를 판단합니다.

아래 메시지가 "모델 호출해봐", "호출해봐", "테스트" 등의 의도가 있는지 판단하세요.

규칙:
- "모델", "호출", "테스트", "model", "call" 등 포함 시 true
- 그 외 false

출력: {"isModelRequest":true|false}

메시지: "${normalized.replace(/"/g, '\\"')}"`;

  try {
    const result = await callModel(prompt);
    const parsed = safeParseJsonObject(result);
    if (parsed && typeof parsed.isModelRequest === "boolean") {
      return parsed.isModelRequest;
    }
  } catch {
    // ignore
  }

  return false;
}

// 4. 코드 트리거 감지
export async function detectCodeTrigger(text) {
  const normalized = String(text || "").toLowerCase();
  const codeTriggers = [
    "코드",
    "소스",
    "함수",
    "메서드",
    "메소드",
    "구현",
    "내부",
    "동작",
    "작동",
    "로직",
    "버그",
    "오류",
    "에러",
    "디버그",
    "정의",
    "설계",
    "함수명",
    "메서드명",
    "미들웨어",
    "라이브러리",
    "모듈",
    "구조",
    "source",
    "code",
    "implementation",
  ];
  if (codeTriggers.some((keyword) => normalized.includes(keyword))) {
    return true;
  }

  const prompt = `당신은 사용자 메시지에서 코드 조회 의도를 판단합니다.

아래 메시지가 "코드 보여줘", "소스코드", "내부 구현" 등의 의도가 있는지 판단하세요.

규칙:
- "코드", "소스", "내부", "source", "code" 등 포함 시 true
- 그 외 false

출력: {"isCodeRequest":true|false}

메시지: "${String(text || "").replace(/"/g, '\\"')}"`;

  try {
    const result = await callModel(prompt);
    const parsed = safeParseJsonObject(result);
    if (parsed && typeof parsed.isCodeRequest === "boolean") {
      return parsed.isCodeRequest;
    }
  } catch {
    // ignore
  }

  return false;
}

// 5. 날씨 요청 파싱 (AI 판별)
export async function parseWeatherRequest(text) {
  const normalized = String(text || "").trim();
  const defaultResult = { isWeatherRequest: false, listRegions: false, regionName: "서울" };
  if (!normalized) return defaultResult;

  const regionNames = Object.keys(REGION_MAP);
  const regionListText = regionNames.join(", ");

  const prompt = `당신은 디스코드 봇의 날씨 요청 분석기입니다.
아래 사용자 메시지를 분석해 JSON 객체 1개만 출력하세요.

출력 필드:
- isWeatherRequest: true|false — 날씨·기상·기온·예보·weather 등 날씨 정보를 묻는 요청이면 true
- listRegions: true|false — 조회 가능한 지역 목록을 달라는 요청이면 true (예: "지역 목록", "어디 조회 가능해")
- regionName: 조회할 지역명. 아래 목록에 있는 이름만 사용. 지역이 없거나 불명확하면 "서울"

규칙:
- 잡담·시간 질문·일반 지식 질문은 isWeatherRequest=false
- "송도", "부산 날씨", "오늘 서울 기온" 등은 isWeatherRequest=true
- listRegions가 true면 regionName은 무시해도 됨
- regionName은 반드시 아래 목록 중 정확히 하나: ${regionListText}

메시지: "${normalized.replace(/"/g, '\\"')}"

출력 예: {"isWeatherRequest":true,"listRegions":false,"regionName":"부산"}`;

  try {
    const result = await callModel(prompt);
    const parsed = safeParseJsonObject(result);
    if (parsed && typeof parsed.isWeatherRequest === "boolean") {
      let regionName = String(parsed.regionName || "서울").trim();
      if (!REGION_MAP[regionName]) {
        const matched = regionNames.find((name) => normalized.includes(name));
        regionName = matched || "서울";
      }
      return {
        isWeatherRequest: parsed.isWeatherRequest,
        listRegions: Boolean(parsed.listRegions),
        regionName,
      };
    }
  } catch {
    // ignore
  }

  return defaultResult;
}

/** @deprecated parseWeatherRequest 사용 */
export async function detectWeatherKeyword(text) {
  const plan = await parseWeatherRequest(text);
  return plan.isWeatherRequest;
}

// 6. 토큰 추출
export async function extractTokens(text) {
  const tokens = String(text || "").match(/[가-힣a-zA-Z0-9_]+/g) || [];
  const dedup = new Set(
    tokens
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 2 && t.length <= 40 && !/^\d+$/.test(t)),
  );
  const regexResult = Array.from(dedup).slice(0, 10);
  if (regexResult.length > 0) {
    return regexResult;
  }

  const prompt = `당신은 텍스트에서 의미 있는 토큰을 추출합니다.

아래 텍스트에서:
1. 한글, 영문, 숫자로 된 단어 추출
2. 2자 이상 40자 이하만
3. 숫자만 있는 토큰 제외
4. 중복 제거
5. 최대 10개

출력: {"tokens":["토큰1", "토큰2"]}

텍스트: "${String(text || "").replace(/"/g, '\\"')}"`;

  try {
    const result = await callModel(prompt);
    const parsed = safeParseJsonObject(result);
    if (Array.isArray(parsed?.tokens)) {
      return parsed.tokens.filter((t) => typeof t === "string" && t.length >= 2 && t.length <= 40);
    }
  } catch {
    // ignore
  }

  return regexResult;
}

// 7. 스택 트레이스에서 파일/라인 추출
export async function extractStackReferences(stackTrace) {
  const refs = [];
  const matches = String(stackTrace || "").matchAll(/\(?([A-Za-z0-9_.\-\\/]+\.js):(\d+):(\d+)\)?/g);
  for (const match of matches) {
    const relPath = match[1].replace(/\\/g, "/").split("/").slice(-1)[0];
    const line = Number(match[2]);
    if (relPath && Number.isInteger(line)) {
      refs.push({ file: relPath, line });
    }
    if (refs.length >= 10) break;
  }
  if (refs.length > 0) {
    return refs;
  }

  const prompt = `당신은 JavaScript 에러 스택 트레이스 파서입니다.

아래 스택에서 파일명과 라인번호를 추출하세요.

규칙:
- filename.js:123:45 형태 찾기
- 최대 10개
- path/to/file.js 형태면 파일명만 추출

출력: {"references":[{"file":"filename.js","line":123}]}

스택:
\`\`\`
${String(stackTrace || "").slice(0, 1000)}
\`\`\``;

  try {
    const result = await callModel(prompt);
    const parsed = safeParseJsonObject(result);
    if (Array.isArray(parsed?.references)) {
      return parsed.references
        .filter((ref) => ref && typeof ref.file === "string" && typeof ref.line === "number")
        .slice(0, 10);
    }
  } catch {
    // ignore
  }

  return refs;
}

// 8. 텍스트 정규화 (공백 제거)
export function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// 9. 문자열 정규화 (인용부호/기호 제거)
export function normalizeQuotes(text) {
  return String(text || "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[?!.,]+$/g, "")
    .trim();
}

// 10. 중괄호 매칭
export function findMatchingBrace(lines, startLine) {
  let braceCount = 0;
  let foundBlock = false;
  const lineArr = Array.isArray(lines) ? lines : [];
  for (let i = startLine; i < Math.min(lineArr.length, startLine + 50); i += 1) {
    const line = lineArr[i] || "";
    const openMatches = line.match(/{/g) || [];
    const closeMatches = line.match(/}/g) || [];
    braceCount += openMatches.length;
    braceCount -= closeMatches.length;
    if (openMatches.length > 0) foundBlock = true;
    if (foundBlock && braceCount <= 0) return i;
  }
  return Math.min(startLine + 49, Math.max(startLine, lineArr.length - 1));
}
