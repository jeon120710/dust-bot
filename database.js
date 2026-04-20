import Database from "better-sqlite3";
import { logError } from "./logger.js";

const db = new Database("memory.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_conversation_memory_user
  ON conversation_memory(guild_id, user_id, id DESC);
`);

const insertMemoryStmt = db.prepare(`
  INSERT INTO conversation_memory (guild_id, user_id, role, content)
  VALUES (@guildId, @userId, @role, @content)
`);

const selectRecentMemoryStmt = db.prepare(`
  SELECT role, content
  FROM conversation_memory
  WHERE guild_id = ? AND user_id = ?
  ORDER BY id DESC
  LIMIT ?
`);

const pruneMemoryStmt = db.prepare(`
  DELETE FROM conversation_memory
  WHERE guild_id = ? AND user_id = ?
    AND id NOT IN (
      SELECT id
      FROM conversation_memory
      WHERE guild_id = ? AND user_id = ?
      ORDER BY id DESC
      LIMIT ?
    )
`);

const clearMemoryStmt = db.prepare(`
  DELETE FROM conversation_memory
  WHERE guild_id = ? AND user_id = ?
`);

export function getMemoryScope(message) {
  return {
    guildId: message.guild?.id || `dm:${message.channelId}`,
    userId: message.author.id,
  };
}

export function saveConversation(message, role, content) {
  const text = String(content || "").trim();
  if (!text) return;

  try {
    const { guildId, userId } = getMemoryScope(message);
    insertMemoryStmt.run({
      guildId,
      userId,
      role,
      content: text.slice(0, 2000),
    });
    pruneMemoryStmt.run(guildId, userId, guildId, userId, 60);
  } catch (error) {
    logError("database.saveConversation", error, {
      guildId: message.guild?.id || null,
      userId: message.author?.id || null,
      role,
    });
  }
}

export function getRecentConversation(message, limit = 12) {
  try {
    const { guildId, userId } = getMemoryScope(message);
    return selectRecentMemoryStmt.all(guildId, userId, limit).reverse();
  } catch (error) {
    logError("database.getRecentConversation", error, {
      guildId: message.guild?.id || null,
      userId: message.author?.id || null,
      limit,
    });
    return [];
  }
}

export function clearConversation(message, targetUserId) {
  try {
    const { guildId } = getMemoryScope(message);
    const userId = String(targetUserId || message.author.id);
    clearMemoryStmt.run(guildId, userId);
  } catch (error) {
    logError("database.clearConversation", error, {
      guildId: message.guild?.id || null,
      userId: String(targetUserId || message.author?.id || ""),
    });
  }
}
