import fs from "node:fs";
import path from "node:path";

const requestPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : "";
const root = process.cwd();
const backupDir = path.resolve(root, "logs/error-repair/backups");
const blockedPathParts = new Set(["node_modules", "logs", ".git"]);
const blockedFiles = new Set(["package-lock.json", "memory.db", ".env"]);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function isSafeTarget(relPath) {
  const normalized = String(relPath || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) return false;
  const parts = normalized.split("/");
  if (parts.some((part) => blockedPathParts.has(part))) return false;
  if (blockedFiles.has(parts.at(-1))) return false;
  return normalized.endsWith(".js") || normalized.endsWith(".json");
}

if (!requestPath || !fs.existsSync(requestPath)) {
  fail("repair request file not found");
} else {
  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  } catch (error) {
    fail(`failed to parse repair request: ${error.message}`);
  }

  const edits = Array.isArray(request?.analysis?.fileEdits)
    ? request.analysis.fileEdits
    : [];

  if (edits.length === 0) {
    fail("no confident file edits were proposed");
  } else {
    fs.mkdirSync(backupDir, { recursive: true });
    const applied = [];

    for (const edit of edits) {
      const relPath = String(edit?.path || "").trim();
      const find = String(edit?.find || "");
      const replace = String(edit?.replace || "");

      if (!isSafeTarget(relPath)) {
        fail(`blocked unsafe target path: ${relPath}`);
        break;
      }
      if (!find) {
        fail(`empty find text for ${relPath}`);
        break;
      }

      const targetPath = path.resolve(root, relPath);
      if (!targetPath.startsWith(root) || !fs.existsSync(targetPath)) {
        fail(`target file not found: ${relPath}`);
        break;
      }

      const before = fs.readFileSync(targetPath, "utf8");
      const first = before.indexOf(find);
      const last = before.lastIndexOf(find);
      if (first === -1) {
        fail(`find text not found in ${relPath}`);
        break;
      }
      if (first !== last) {
        fail(`find text is not unique in ${relPath}`);
        break;
      }

      const backupPath = path.resolve(
        backupDir,
        `${Date.now()}-${relPath.replace(/[\\/]/g, "__")}.bak`,
      );
      fs.writeFileSync(backupPath, before, "utf8");
      fs.writeFileSync(targetPath, before.slice(0, first) + replace + before.slice(first + find.length), "utf8");
      applied.push(`${relPath} (backup: ${path.relative(root, backupPath)})`);
    }

    if (process.exitCode) {
      process.exit();
    }

    console.log(`applied ${applied.length} edit(s)`);
    for (const item of applied) {
      console.log(`- ${item}`);
    }
  }
}
