export function stripCodeFence(text) {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function safeParseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    const objectMatch = raw.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const recovered = JSON.parse(objectMatch[0]);
        if (recovered && typeof recovered === "object") return recovered;
      } catch {
        // ignore parse errors
      }
    }
  }
  return null;
}

export function appendCompletionMark(text, mark = " ✅") {
  const raw = String(text ?? "");
  const trimmed = raw.trimEnd();
  if (!trimmed) return raw;
  if (/[✅✔☑]$/.test(trimmed)) return raw;
  return `${trimmed}${mark}`;
}

export function formatHistoryForPrompt(history) {
  if (!Array.isArray(history) || history.length === 0) return "없음";
  return history
    .map((item) => `${item.role === "user" ? "사용자" : "봇"}: ${item.content}`)
    .join("\n");
}

export function parseAiAction(aiResponse) {
  const cleaned = stripCodeFence(aiResponse);

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
      return parsed;
    }
  } catch {
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const recovered = JSON.parse(objectMatch[0]);
        if (recovered && typeof recovered === "object" && typeof recovered.action === "string") {
          return recovered;
        }
      } catch {
        // no-op
      }
    }
  }

  return {
    action: "reply",
    message: aiResponse,
  };
}

export function normalizeSnowflake(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const mention = raw.match(/^<(?:@!?|#|@&)(\d+)>$/);
  if (mention) return mention[1];

  if (/^\d{17,20}$/.test(raw)) return raw;
  return "";
}

export function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeComparableName(value) {
  return normalizeName(value).replace(/[^a-z0-9가-힣]/g, "");
}

export function toKoreanLetterPronunciation(value) {
  const letterMap = {
    A: "에이",
    B: "비",
    C: "씨",
    D: "디",
    E: "이",
    F: "에프",
    G: "지",
    H: "에이치",
    I: "아이",
    J: "제이",
    K: "케이",
    L: "엘",
    M: "엠",
    N: "엔",
    O: "오",
    P: "피",
    Q: "큐",
    R: "알",
    S: "에스",
    T: "티",
    U: "유",
    V: "브이",
    W: "더블유",
    X: "엑스",
    Y: "와이",
    Z: "지",
  };

  const letters = String(value || "")
    .toUpperCase()
    .match(/[A-Z]/g);

  if (!letters || letters.length === 0) return "";
  return letters.map((ch) => letterMap[ch] || "").join("");
}

export function composeHangul(initialIndex, medialIndex) {
  return String.fromCharCode(0xac00 + (initialIndex * 21 + medialIndex) * 28);
}

export function transliterateEnglishWordToKorean(word) {
  const text = String(word || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!text) return "";

  const initialMap = {
    g: 0,
    k: 15,
    c: 15,
    q: 15,
    n: 2,
    d: 3,
    t: 16,
    r: 5,
    l: 5,
    m: 6,
    b: 7,
    p: 17,
    s: 9,
    j: 12,
    h: 18,
    f: 17,
    v: 17,
    x: 15,
    z: 12,
    ch: 14,
    sh: 9,
    th: 16,
    ph: 17,
    wh: 18,
    ng: 11,
  };

  const medialMap = {
    a: 0,
    ae: 1,
    ya: 2,
    yae: 3,
    eo: 4,
    e: 5,
    yeo: 6,
    ye: 7,
    o: 8,
    wa: 9,
    wae: 10,
    oe: 11,
    yo: 12,
    u: 13,
    wo: 14,
    we: 15,
    wi: 16,
    yu: 17,
    eu: 18,
    ui: 19,
    i: 20,
  };

  const onsetTokens = ["ch", "sh", "th", "ph", "wh", "ng"];
  const vowelTokens = [
    "yae",
    "yeo",
    "wae",
    "ae",
    "ya",
    "eo",
    "ye",
    "wa",
    "oe",
    "yo",
    "wo",
    "we",
    "wi",
    "yu",
    "eu",
    "ui",
    "a",
    "e",
    "i",
    "o",
    "u",
  ];

  let i = 0;
  let out = "";

  while (i < text.length) {
    let onset = "";
    let onsetLen = 0;

    for (const token of onsetTokens) {
      if (text.startsWith(token, i)) {
        onset = token;
        onsetLen = token.length;
        break;
      }
    }

    if (!onset) {
      const one = text[i];
      if ("aeiouy".includes(one)) {
        onset = "";
        onsetLen = 0;
      } else {
        onset = one;
        onsetLen = 1;
      }
    }

    const vowelStart = i + onsetLen;
    let vowel = "";
    let vowelLen = 0;
    for (const token of vowelTokens) {
      if (text.startsWith(token, vowelStart)) {
        vowel = token;
        vowelLen = token.length;
        break;
      }
    }

    if (!vowel) {
      i += Math.max(onsetLen, 1);
      continue;
    }

    let initialIndex = 11;
    if (onset) {
      initialIndex = initialMap[onset] ?? initialMap[onset[0]] ?? 11;
    }

    let medialIndex = medialMap[vowel] ?? 20;
    if (onset === "sh") {
      if (vowel === "a") medialIndex = 2;
      if (vowel === "o") medialIndex = 12;
      if (vowel === "u") medialIndex = 17;
    }

    out += composeHangul(initialIndex, medialIndex);
    i = vowelStart + vowelLen;
  }

  return out;
}

export function getNameQueryVariants(query) {
  const raw = normalizeName(query);
  const comparable = normalizeComparableName(query);
  const variants = new Set([raw, comparable]);

  const suffixes = ["입니다", "이에요", "예요", "이야", "은", "는", "이", "가", "을", "를", "도", "만"];
  for (const suffix of suffixes) {
    if (raw.endsWith(suffix) && raw.length > suffix.length) {
      variants.add(raw.slice(0, -suffix.length));
    }
    if (comparable.endsWith(suffix) && comparable.length > suffix.length) {
      variants.add(comparable.slice(0, -suffix.length));
    }
  }

  return Array.from(variants).filter(Boolean);
}

export function looksLikeDoneMessage(text) {
  const v = String(text || "").toLowerCase();
  const doneKeywords = ["완료", "done", "completed", "success"];
  if (doneKeywords.some((k) => v.includes(String(k).toLowerCase()))) return true;
  if (/(처리|적용|전송|삭제|타임아웃|강퇴|밴).*(했|하였|됨|되었습니다)/i.test(v)) return true;
  return false;
}
