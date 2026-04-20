import {
  normalizeName,
  normalizeComparableName,
  normalizeSnowflake,
  toKoreanLetterPronunciation,
  transliterateEnglishWordToKorean,
  getNameQueryVariants,
} from "./utils.js";

function getMemberAliases(member) {
  const base = [
    member.nickname,
    member.displayName,
    member.user?.username,
    member.user?.globalName,
    member.user?.tag,
  ];

  const aliases = new Set();
  for (const value of base) {
    const n = normalizeName(value);
    if (n) aliases.add(n);

    const pron = toKoreanLetterPronunciation(value);
    if (pron) aliases.add(normalizeName(pron));

    const words = String(value || "").match(/[A-Za-z]{2,}/g) || [];
    for (const w of words) {
      const spoken = transliterateEnglishWordToKorean(w);
      if (spoken) aliases.add(normalizeName(spoken));
    }
  }

  return Array.from(aliases);
}

function findMemberByName(members, query, options = {}) {
  const strict = options.strict === true;
  const q = normalizeName(query);
  const qComparable = normalizeComparableName(query);
  const qVariants = getNameQueryVariants(query);
  if (!q) return { member: null, ambiguous: [], matchType: "" };

  const exact = [];
  const exactComparable = [];
  const partial = [];
  const partialComparable = [];

  for (const member of members.values()) {
    const aliases = getMemberAliases(member);
    const aliasesComparable = aliases.map((a) => normalizeComparableName(a));

    if (aliases.some((a) => a === q) || aliases.some((a) => qVariants.includes(a))) {
      exact.push(member);
      continue;
    }
    if (qComparable && (aliasesComparable.some((a) => a === qComparable) || aliasesComparable.some((a) => qVariants.includes(a)))) {
      exactComparable.push(member);
      continue;
    }
    if (aliases.some((a) => a.includes(q)) || aliases.some((a) => qVariants.some((v) => a.includes(v)))) {
      partial.push(member);
      continue;
    }
    if (qComparable && (aliasesComparable.some((a) => a.includes(qComparable)) || aliasesComparable.some((a) => qVariants.some((v) => a.includes(v))))) {
      partialComparable.push(member);
    }
  }

  if (exact.length === 1) return { member: exact[0], ambiguous: [], matchType: "exact" };
  if (exact.length > 1) return { member: null, ambiguous: exact, matchType: "exact" };
  if (exactComparable.length === 1) return { member: exactComparable[0], ambiguous: [], matchType: "exact_comparable" };
  if (exactComparable.length > 1) return { member: null, ambiguous: exactComparable, matchType: "exact_comparable" };
  if (strict) return { member: null, ambiguous: [], matchType: "" };
  if (partial.length === 1) return { member: partial[0], ambiguous: [], matchType: "partial" };
  if (partial.length > 1) return { member: null, ambiguous: partial, matchType: "partial" };
  if (partialComparable.length === 1) return { member: partialComparable[0], ambiguous: [], matchType: "partial_comparable" };
  if (partialComparable.length > 1) return { member: null, ambiguous: partialComparable, matchType: "partial_comparable" };
  return { member: null, ambiguous: [], matchType: "" };
}

export async function resolveTargetMember(guild, rawValue, options = {}) {
  const strict = options.strict === true;
  const safeFuzzy = options.safeFuzzy === true;
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return { ok: false, message: "대상 유저 정보가 없습니다. userId 또는 닉네임을 입력해 주세요." };
  }

  const byId = normalizeSnowflake(raw);
  if (byId) {
    try {
      const member = await guild.members.fetch(byId);
      return { ok: true, member };
    } catch {
      return { ok: false, message: `ID ${byId} 유저를 찾을 수 없습니다.` };
    }
  }

  try {
    await guild.members.fetch();
  } catch {
    // fetch 실패 시 현재 캐시로만 검색
  }

  const { member, ambiguous, matchType } = findMemberByName(guild.members.cache, raw, { strict });
  if (member) {
    if (safeFuzzy && (matchType === "partial" || matchType === "partial_comparable")) {
      const queryLen = normalizeComparableName(raw).length;
      if (queryLen < 3) {
        return {
          ok: false,
          message: `\"${raw}\"는 너무 짧아 오탐 위험이 큽니다. 더 긴 이름, 멘션, 또는 숫자 ID로 지정해 주세요.`,
        };
      }
    }
    return { ok: true, member, matchType };
  }

  if (ambiguous.length > 1) {
    const preview = ambiguous
      .slice(0, 5)
      .map((m) => `${m.displayName}(${m.user.username})`)
      .join(", ");
    return {
      ok: false,
      message: `동일/유사한 유저가 여러 명입니다. 멘션이나 숫자 ID로 지정해 주세요. 후보: ${preview}`,
    };
  }

  if (strict) {
    return {
      ok: false,
      message: `\"${raw}\"와 정확히 일치하는 유저를 찾지 못했습니다. 오탐 방지를 위해 멘션 또는 숫자 ID로 지정해 주세요.`,
    };
  }

  return { ok: false, message: `\"${raw}\" 유저를 찾지 못했습니다. 멘션 또는 숫자 ID를 사용해 주세요.` };
}

export function isExplicitTargetInInput(input, member, targetInput) {
  const rawInput = String(input || "");
  const normalizedInput = normalizeComparableName(rawInput);

  const id = member?.id || "";
  if (id && (rawInput.includes(`<@${id}>`) || rawInput.includes(`<@!${id}>`) || rawInput.includes(id))) {
    return true;
  }

  const aliases = getMemberAliases(member).map((a) => normalizeComparableName(a));
  if (aliases.some((a) => a && normalizedInput.includes(a))) {
    return true;
  }

  const targetNorm = normalizeComparableName(targetInput);
  if (targetNorm && normalizedInput.includes(targetNorm)) {
    return true;
  }

  return false;
}

export { getMemberAliases, findMemberByName };
