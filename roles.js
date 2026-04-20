import { normalizeName, normalizeSnowflake } from "./utils.js";

function getRoleAliases(role) {
  return [role.name, role.id].map((v) => normalizeName(v)).filter(Boolean);
}

function findRoleByName(roles, query) {
  const q = normalizeName(query);
  if (!q) return { role: null, ambiguous: [] };

  const exact = [];
  const partial = [];

  for (const role of roles.values()) {
    const aliases = getRoleAliases(role);
    if (aliases.some((a) => a === q)) {
      exact.push(role);
      continue;
    }
    if (aliases.some((a) => a.includes(q))) {
      partial.push(role);
    }
  }

  if (exact.length === 1) return { role: exact[0], ambiguous: [] };
  if (exact.length > 1) return { role: null, ambiguous: exact };
  if (partial.length === 1) return { role: partial[0], ambiguous: [] };
  if (partial.length > 1) return { role: null, ambiguous: partial };
  return { role: null, ambiguous: [] };
}

export async function resolveTargetRole(guild, rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return { ok: false, message: "대상 역할 정보가 없습니다. roleId 또는 역할 이름을 입력해 주세요." };
  }

  const mention = raw.match(/^<@&(\d+)>$/);
  const byId = mention ? mention[1] : normalizeSnowflake(raw);
  if (byId) {
    const role = guild.roles.cache.get(byId) || (await guild.roles.fetch(byId).catch(() => null));
    if (role) return { ok: true, role };
    return { ok: false, message: `ID ${byId} 역할을 찾을 수 없습니다.` };
  }

  try {
    await guild.roles.fetch();
  } catch {
    // fetch 실패 시 현재 캐시로만 검색
  }

  const { role, ambiguous } = findRoleByName(guild.roles.cache, raw);
  if (role) {
    return { ok: true, role };
  }

  if (ambiguous.length > 1) {
    const preview = ambiguous
      .slice(0, 5)
      .map((r) => `${r.name}(${r.id})`)
      .join(", ");
    return {
      ok: false,
      message: `동일/유사한 역할이 여러 개입니다. 역할 ID나 멘션으로 지정해 주세요. 후보: ${preview}`,
    };
  }

  return { ok: false, message: `\"${raw}\" 역할을 찾지 못했습니다. 역할 멘션 또는 ID를 사용해 주세요.` };
}

export { getRoleAliases, findRoleByName };
