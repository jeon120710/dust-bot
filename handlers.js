import { PermissionFlagsBits } from "discord.js";
import { resolveTargetMember } from "./members.js";
import { resolveTargetRole } from "./roles.js";
import { normalizeComparableName } from "./utils.js";
import { logActionAudit, logError } from "./logger.js";
import { resolvePermissionNames, listPermissionExamples } from "./permissions.js";
import { updateStatusMessage } from "./status.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanTargetText(value) {
  return String(value || "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[?!.,]+$/g, "")
    .trim();
}

function clampMentionCount(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, 20);
}

function formatPermissionPreview(permissionNames, title, previewLimit = 18) {
  const unique = Array.from(new Set((permissionNames || []).map((name) => String(name || "").trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
  if (unique.length === 0) {
    return `${title}: 없음`;
  }

  const preview = unique.slice(0, previewLimit).join(", ");
  const remain = unique.length - previewLimit;
  const suffix = remain > 0 ? ` 외 ${remain}개` : "";
  return `${title} (${unique.length}개): ${preview}${suffix}`;
}

async function updateStatus(message, statusMessage, text, options = {}) {
  await updateStatusMessage(message, statusMessage, text, {
    permissionLines: options.permissionLines,
    fallbackToChannel: false,
    saveCompletedText: true,
  });
}

export async function tryHandleServerOwnerLookupQuestion(message, statusMessage) {
  if (!message.guild) return false;

  const owner = await message.guild.fetchOwner().catch(() => null);
  if (!owner) {
    await updateStatus(message, statusMessage, "서버장 정보를 가져오지 못했습니다.");
    return true;
  }

  await updateStatus(
    message,
    statusMessage,
    `이 서버의 서버장은 <@${owner.id}> (${owner.user?.tag || owner.displayName}) 입니다.`,
    { permissionLines: ["서버 정보 조회: Guilds 권한"] },
  );
  return true;
}

export async function tryHandleRoleMemberLookupQuestion(message, statusMessage, target) {
  if (!message.guild) return false;

  const roleTarget = cleanTargetText(target);
  if (!roleTarget) return false;

  const resolvedRole = await resolveTargetRole(message.guild, roleTarget);
  if (!resolvedRole.ok) {
    await updateStatus(message, statusMessage, resolvedRole.message);
    return true;
  }

  const role = resolvedRole.role;
  await message.guild.members.fetch().catch(() => null);
  const membersWithRole = Array.from(message.guild.members.cache.values()).filter(
    (member) => member.roles?.cache?.has(role.id) && !member.user?.bot,
  );

  if (membersWithRole.length === 0) {
    await updateStatus(message, statusMessage, `"${role.name}" 역할을 가진 멤버를 찾지 못했습니다.`);
    return true;
  }

  const previewLimit = 25;
  const preview = membersWithRole
    .slice(0, previewLimit)
    .map((member) => member.displayName || member.user?.username || member.id)
    .join(", ");

  const remain = membersWithRole.length - previewLimit;
  const remainText = remain > 0 ? `\n외 ${remain}명` : "";
  const resultText = `"${role.name}" 역할을 가진 멤버는 총 ${membersWithRole.length}명입니다.\n${preview}${remainText}`;

  await updateStatus(
    message,
    statusMessage,
    resultText,
    { permissionLines: ["서버 멤버/역할 조회: GuildMembers 권한"] },
  );
  return true;
}

export async function tryHandleMemberLookupQuestion(message, statusMessage, target) {
  if (!message.guild) return false;
  const cleanTarget = cleanTargetText(target || "");
  if (!cleanTarget) return false;

  const resolved = await resolveTargetMember(message.guild, cleanTarget, { strict: true });
  if (resolved.ok) {
    const found = resolved.member;
    const corrected = normalizeComparableName(found.displayName) === normalizeComparableName(cleanTarget)
      ? found.displayName
      : `${cleanTarget} (서버 표시 이름: ${found.displayName})`;

    await updateStatus(
      message,
      statusMessage,
      `확인했습니다. 검색 결과: "${corrected}" 입니다.`,
      { permissionLines: ["서버 멤버 정보 조회: GuildMembers 권한"] },
    );
    return true;
  }

  // 멤버 검색 실패 시 역할명으로 들어온 요청을 한 번 더 처리합니다.
  const resolvedRole = await resolveTargetRole(message.guild, cleanTarget);
  if (resolvedRole.ok) {
    return tryHandleRoleMemberLookupQuestion(message, statusMessage, cleanTarget);
  }

  await updateStatus(message, statusMessage, `"${cleanTarget}"와(과) 일치하는 멤버를 찾지 못했습니다.`);
  return true;
}

export async function tryHandleMentionRequest(message, statusMessage, target, mentionCount = 1) {
  if (!message.guild) return false;
  const cleanTarget = cleanTargetText(target || "");
  if (!cleanTarget) return false;
  const count = clampMentionCount(mentionCount);

  const resolved = await resolveTargetMember(message.guild, cleanTarget);
  if (!resolved.ok) {
    await updateStatus(message, statusMessage, resolved.message);
    return true;
  }

  const verifiedMember = await message.guild.members.fetch(resolved.member.id).catch(() => null);
  if (!verifiedMember) {
    await updateStatus(
      message,
      statusMessage,
      `"${cleanTarget}" 사용자를 찾지 못했습니다. 멘션 가능한 정확한 닉네임 또는 ID를 사용해 주세요.`,
    );
    return true;
  }

  const mentionText = Array.from({ length: count }, () => `<@${verifiedMember.id}>`).join(" ");
  await updateStatus(message, statusMessage, mentionText, {
    permissionLines: ["서버 멤버 정보 조회: GuildMembers 권한"],
  });
  return true;
}

export async function tryHandleMemberPermissionLookupQuestion(message, statusMessage, target) {
  if (!message.guild) return false;

  const cleanTarget = cleanTargetText(target || "");
  let member = null;

  if (!cleanTarget) {
    member = message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
  } else {
    const resolved = await resolveTargetMember(message.guild, cleanTarget, { strict: true });
    if (!resolved.ok) {
      await updateStatus(message, statusMessage, resolved.message);
      return true;
    }
    member = resolved.member;
  }

  if (!member) {
    await updateStatus(message, statusMessage, "권한을 조회할 멤버 정보를 찾을 수 없습니다.");
    return true;
  }

  const guildPermissionNames = member.permissions?.toArray?.() || [];
  const channelPermissionNames =
    message.channel?.isTextBased?.() && typeof message.channel.permissionsFor === "function"
      ? message.channel.permissionsFor(member)?.toArray?.() || []
      : [];

  const displayName = member.displayName || member.user?.username || member.id;
  const guildSummary = formatPermissionPreview(guildPermissionNames, "서버 권한");
  const channelSummary = formatPermissionPreview(channelPermissionNames, "현재 채널 권한");
  const responseText = `"${displayName}"님의 권한 조회 결과입니다.\n${guildSummary}\n${channelSummary}`;

  await updateStatus(
    message,
    statusMessage,
    responseText,
    { permissionLines: ["서버 멤버 권한 조회: GuildMembers 권한"] },
  );
  return true;
}

export async function handleBatchTimeout(message, statusMessage, durationMinutes, excludeRoleId) {
  const guild = message.guild;
  if (!guild) {
    await updateStatus(message, statusMessage, "이 기능은 서버에서만 사용할 수 있습니다.");
    return;
  }

  if (!message.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await updateStatus(message, statusMessage, "요청자에게 타임아웃 관리 권한(ModerateMembers)이 없습니다.");
    return;
  }

  const botMember = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    await updateStatus(message, statusMessage, "봇 멤버 정보를 불러오지 못했습니다.");
    return;
  }
  if (!botMember.permissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await updateStatus(message, statusMessage, "봇에게 타임아웃 관리 권한(ModerateMembers)이 없습니다.");
    return;
  }

  const durationMs = durationMinutes * 60 * 1000;
  if (durationMs <= 0 || durationMs > 28 * 24 * 60 * 60 * 1000) {
    await updateStatus(message, statusMessage, "타임아웃 기간이 유효하지 않습니다. (최대 28일)");
    return;
  }

  try {
    await guild.members.fetch();
    const allMembers = Array.from(guild.members.cache.values());
    console.log(`Total server members: ${allMembers.length}`);

    const manageableMembers = allMembers.filter((m) => m.manageable);
    console.log(`Manageable members: ${manageableMembers.length}`);

    const nonBotMembers = manageableMembers.filter((m) => !m.user.bot);
    console.log(`Non-bot manageable members: ${nonBotMembers.length}`);

    const members = nonBotMembers.filter((m) => !excludeRoleId || !m.roles.cache.has(excludeRoleId));
    console.log(`Final target members: ${members.length}`);

    // 추가 검증: 실제로 타임아웃 가능한 멤버만 필터링
    const timeoutableMembers = members.filter((m) => {
      try {
        return m.moderatable; // Discord.js의 moderatable 속성 사용
      } catch {
        return false;
      }
    });
    console.log(`Actually timeoutable members: ${timeoutableMembers.length}`);

    if (timeoutableMembers.length === 0) {
      await updateStatus(message, statusMessage, "타임아웃을 적용할 수 있는 멤버가 없습니다. 봇의 권한이나 역할 계층을 확인해주세요.");
      return;
    }

    // 최종 멤버 리스트 사용
    const finalMembers = timeoutableMembers;

    // 상태 메시지 업데이트: 실제 타임아웃 가능한 멤버 수로
    const updatedSummary = buildBatchTimeoutSummary(durationMinutes, excludeRoleId, finalMembers.length);
    try {
      await statusMessage.edit(updatedSummary);
    } catch {
      // ignore edit errors
    }

    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < finalMembers.length; i++) {
      const member = finalMembers[i];
      try {
        await member.timeout(durationMs, "배치 타임아웃 명령");
        successCount++;
      } catch (error) {
        // Rate limit 에러인 경우 대기 후 재시도
        if (error?.status === 429) {
          const retryAfter = error?.retryAfter || 30;
          console.log(`Rate limited, waiting ${retryAfter} seconds...`);
          await sleep(retryAfter * 1000 + 1000); // 추가 1초 버퍼
          try {
            await member.timeout(durationMs, "배치 타임아웃 명령");
            successCount++;
          } catch (retryError) {
            console.log(`Retry failed for ${member.user.username}:`, retryError.message);
            failureCount++;
          }
        } else {
          console.log(`Failed to timeout ${member.user.username}:`, error.message);
          failureCount++;
        }
      }
      // 요청 속도 제어: 각 요청 사이에 3초 대기 (Discord rate limit 준수)
      if (i < finalMembers.length - 1) {
        await sleep(3000);
      }
    }

    logActionAudit({
      phase: "success",
      action: "batch.timeout",
      requiredPermission: "ModerateMembers",
      guildId: guild.id,
      userId: message.author?.id || null,
      affectedCount: successCount,
      failureCount,
      durationMinutes,
    });

    await updateStatus(message, statusMessage, `타임아웃 처리 완료: 성공 ${successCount}명, 실패 ${failureCount}명`, {
      permissionLines: ["타임아웃 관리: ModerateMembers 권한"],
    });
  } catch (error) {
    logError("handlers.batchTimeout", error, {
      guildId: guild.id,
      userId: message.author?.id || null,
    });
    await updateStatus(message, statusMessage, "타임아웃 처리 중 오류가 발생했습니다.");
  }
}

export async function handleBatchRole(message, statusMessage, roleId, mode) {
  const guild = message.guild;
  if (!guild) {
    await updateStatus(message, statusMessage, "이 기능은 서버에서만 사용할 수 있습니다.");
    return;
  }

  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    await updateStatus(message, statusMessage, "요청자에게 역할 관리 권한(ManageRoles)이 없습니다.");
    return;
  }

  const botMember = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    await updateStatus(message, statusMessage, "봇 멤버 정보를 불러오지 못했습니다.");
    return;
  }
  if (!botMember.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    await updateStatus(message, statusMessage, "봇에게 역할 관리 권한(ManageRoles)이 없습니다.");
    return;
  }

  const role = guild.roles.cache.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));
  if (!role) {
    await updateStatus(message, statusMessage, "선택한 역할을 찾을 수 없습니다.");
    return;
  }
  if (!role.editable) {
    await updateStatus(message, statusMessage, "해당 역할은 봇보다 상위이거나 관리 불가능한 역할입니다.");
    return;
  }

  try {
    await guild.members.fetch();
    const allMembers = Array.from(guild.members.cache.values());
    console.log(`Total server members: ${allMembers.length}`);

    const manageableMembers = allMembers.filter((m) => m.manageable);
    console.log(`Manageable members: ${manageableMembers.length}`);

    const members = manageableMembers.filter((m) => !m.user.bot);
    console.log(`Non-bot manageable members: ${members.length}`);

    if (members.length === 0) {
      await updateStatus(message, statusMessage, "대상 멤버가 없습니다.");
      return;
    }

    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      try {
        if (mode === "add") {
          if (!member.roles.cache.has(role.id)) {
            await member.roles.add(role, `배치 역할 ${mode} 명령`);
            successCount++;
          }
        } else {
          if (member.roles.cache.has(role.id)) {
            await member.roles.remove(role, `배치 역할 ${mode} 명령`);
            successCount++;
          }
        }
      } catch (error) {
        // Rate limit 에러인 경우 대기 후 재시도
        if (error?.status === 429) {
          const retryAfter = error?.retryAfter || 30;
          console.log(`Rate limited, waiting ${retryAfter} seconds...`);
          await sleep(retryAfter * 1000 + 1000); // 추가 1초 버퍼
          try {
            if (mode === "add") {
              if (!member.roles.cache.has(role.id)) {
                await member.roles.add(role, `배치 역할 ${mode} 명령`);
                successCount++;
              }
            } else {
              if (member.roles.cache.has(role.id)) {
                await member.roles.remove(role, `배치 역할 ${mode} 명령`);
                successCount++;
              }
            }
          } catch (retryError) {
            console.log(`Retry failed for ${member.user.username}:`, retryError.message);
            failureCount++;
          }
        } else {
          console.log(`Failed to modify role for ${member.user.username}:`, error.message);
          failureCount++;
        }
      }
      // 요청 속도 제어: 각 요청 사이에 3초 대기 (Discord rate limit 준수)
      if (i < members.length - 1) {
        await sleep(3000);
      }
    }

    logActionAudit({
      phase: "success",
      action: mode === "add" ? "batch.assign_role" : "batch.remove_role",
      requiredPermission: "ManageRoles",
      guildId: guild.id,
      userId: message.author?.id || null,
      targetRoleId: role.id,
      affectedCount: successCount,
      failureCount,
    });

    const action = mode === "add" ? "부여" : "제거";
    await updateStatus(message, statusMessage, `역할 ${action} 완료: 성공 ${successCount}명, 실패 ${failureCount}명`, {
      permissionLines: ["역할 관리: ManageRoles 권한"],
    });
  } catch (error) {
    logError("handlers.batchRole", error, {
      guildId: guild.id,
      userId: message.author?.id || null,
      mode,
    });
    await updateStatus(message, statusMessage, "역할 처리 중 오류가 발생했습니다.");
  }
}

export function buildBatchTimeoutSummary(durationMinutes, excludeRoleId, memberCount) {
  const excludeRoleText = excludeRoleId ? `\n- 제외 역할: <@&${excludeRoleId}>` : "";
  return `**모두에게 타임아웃 부여**\n- 기간: ${durationMinutes}분\n- 대상: ${memberCount}명${excludeRoleText}\n\n정말 진행하시겠습니까?\n✅ 확인 | ❌ 취소`;
}

export function buildBatchRoleSummary(roleName, mode, memberCount) {
  const action = mode === "add" ? "부여" : "제거";
  return `**모두에게 역할 ${action}**\n- 역할: ${roleName}\n- 작업: ${action}\n- 대상: ${memberCount}명\n\n정말 진행하시겠습니까?\n✅ 확인 | ❌ 취소`;
}

export async function createRoleWithPermissions(message, statusMessage, roleName, permissionsStr) {
  const guild = message.guild;
  if (!guild) {
    await updateStatus(message, statusMessage, "이 기능은 서버에서만 사용할 수 있습니다.");
    return;
  }

  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    await updateStatus(message, statusMessage, "요청자에게 역할 관리 권한(ManageRoles)이 없습니다.");
    return;
  }

  const botMember = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    await updateStatus(message, statusMessage, "봇 멤버 정보를 불러오지 못했습니다.");
    return;
  }
  if (!botMember.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    await updateStatus(message, statusMessage, "봇에게 역할 관리 권한(ManageRoles)이 없습니다.");
    return;
  }

  const normalizedRoleName = String(roleName || "").trim();
  if (!normalizedRoleName) {
    await updateStatus(message, statusMessage, "생성할 역할명을 지정해주세요.");
    return;
  }

  const { validPermissions, invalidTokens } = resolvePermissionNames(permissionsStr);
  if (validPermissions.length === 0) {
    const availableSample = listPermissionExamples(10).join(", ");
    await updateStatus(message, statusMessage, `유효한 권한이 없습니다. 예시: ${availableSample}`);
    return;
  }

  try {
    const createdRole = await guild.roles.create({
      name: normalizedRoleName,
      permissions: validPermissions,
      reason: "역할 생성 명령",
    });

    logActionAudit({
      phase: "success",
      action: "create_role",
      requiredPermission: "ManageRoles",
      guildId: guild.id,
      userId: message.author?.id || null,
      targetRoleId: createdRole.id,
      permissions: validPermissions,
    });

    const permList = validPermissions.join(", ");
    const invalidSuffix = invalidTokens.length > 0
      ? `\n(무시된 권한: ${invalidTokens.join(", ")})`
      : "";
    await updateStatus(
      message,
      statusMessage,
      `<@&${createdRole.id}> 역할을 생성했습니다.\n권한: ${permList}${invalidSuffix}`,
      { permissionLines: ["역할 관리: ManageRoles 권한"] },
    );
  } catch (error) {
    logError("handlers.createRoleWithPermissions", error, {
      guildId: guild.id,
      userId: message.author?.id || null,
      roleName: normalizedRoleName,
    });
    await updateStatus(message, statusMessage, "역할 생성 중 오류가 발생했습니다.");
  }
}

export async function setRolePermissions(message, statusMessage, roleName, permissionsStr) {
  const guild = message.guild;
  if (!guild) {
    await updateStatus(message, statusMessage, "이 기능은 서버에서만 사용할 수 있습니다.");
    return;
  }

  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    await updateStatus(message, statusMessage, "요청자에게 역할 관리 권한(ManageRoles)이 없습니다.");
    return;
  }

  const botMember = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    await updateStatus(message, statusMessage, "봇 멤버 정보를 불러오지 못했습니다.");
    return;
  }
  if (!botMember.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    await updateStatus(message, statusMessage, "봇에게 역할 관리 권한(ManageRoles)이 없습니다.");
    return;
  }

  const resolvedRole = await resolveTargetRole(guild, roleName);
  if (!resolvedRole.ok) {
    await updateStatus(message, statusMessage, resolvedRole.message);
    return;
  }

  const role = resolvedRole.role;
  if (!role.editable) {
    await updateStatus(message, statusMessage, "해당 역할은 봇보다 상위이거나 관리 불가능한 역할입니다.");
    return;
  }

  const { validPermissions, invalidTokens } = resolvePermissionNames(permissionsStr);
  if (validPermissions.length === 0) {
    const availableSample = listPermissionExamples(10).join(", ");
    await updateStatus(message, statusMessage, `유효한 권한이 없습니다. 예시: ${availableSample}`);
    return;
  }

  try {
    await role.setPermissions(validPermissions, "역할 권한 설정 명령");

    logActionAudit({
      phase: "success",
      action: "set_role_permissions",
      requiredPermission: "ManageRoles",
      guildId: guild.id,
      userId: message.author?.id || null,
      targetRoleId: role.id,
      permissions: validPermissions,
    });

    const permList = validPermissions.join(", ");
    const invalidSuffix = invalidTokens.length > 0
      ? `\n(무시된 권한: ${invalidTokens.join(", ")})`
      : "";
    await updateStatus(
      message,
      statusMessage,
      `<@&${role.id}> 역할의 권한을 다음과 같이 설정했습니다:\n${permList}${invalidSuffix}`,
      { permissionLines: ["역할 관리: ManageRoles 권한"] },
    );
  } catch (error) {
    logError("handlers.setRolePermissions", error, {
      guildId: guild.id,
      userId: message.author?.id || null,
      roleId: role.id,
    });
    await updateStatus(message, statusMessage, "역할 권한 설정 중 오류가 발생했습니다.");
  }
}
