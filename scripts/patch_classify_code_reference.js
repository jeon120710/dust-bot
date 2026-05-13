const fs = require('fs');
const path = require('path');
const filePath = path.resolve(__dirname, '../index.js');
const text = fs.readFileSync(filePath, 'utf8');
const newFn = `async function classifyCodeReferencePlan(input) {
  const text = String(input || "").trim();
  if (!text) {
    return { useCodeReference: false, searchTerms: [], reason: "empty_input" };
  }

  const normalized = text.toLowerCase();
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
    "작업",
  ];

  const useCodeReference = codeTriggers.some((keyword) => normalized.includes(keyword));
  if (!useCodeReference) {
    return { useCodeReference: false, searchTerms: [], reason: "no_code_keywords" };
  }

  const rawTerms = Array.from(
    new Set(
      (text.match(/[가-힣a-zA-Z0-9_]+/g) || [])
        .map((token) => String(token || "").trim().toLowerCase())
        .filter((token) => token.length >= 2 && !/^\\d+$/.test(token)),
    ),
  );

  const stopwords = new Set([
    "이",
    "그",
    "저",
    "것",
    "수",
    "더",
    "다",
    "를",
    "은",
    "는",
    "가",
    "에",
    "도",
    "와",
    "과",
    "으로",
    "만",
    "을",
    "고",
    "지",
    "나",
    "왜",
    "어떻게",
    "무엇",
    "무슨",
    "어떤",
    "있",
    "없",
    "할",
    "합니다",
    "해주세요",
    "해주세요",
  ]);

  const searchTerms = normalizeCodeSearchTerms(
    rawTerms.filter((term) => !stopwords.has(term) && term.length >= 2),
  );

  return {
    useCodeReference: true,
    searchTerms: searchTerms.slice(0, 8),
    reason: searchTerms.length > 0 ? "keyword_match" : "keyword_only",
  };
}`;

const pattern = /async function classifyCodeReferencePlan\(input\) \{[\s\S]*?\r?\n\r?\nfunction getCachedCodeFile\(/m;
const match = pattern.exec(text);
if (!match) {
  throw new Error('pattern not found');
}
const replaced = text.slice(0, match.index) + newFn + '\n\nfunction getCachedCodeFile(' + text.slice(match.index + match[0].length);
fs.writeFileSync(filePath, replaced, 'utf8');
console.log('patched');
