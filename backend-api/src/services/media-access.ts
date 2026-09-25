import { db } from '../db.js';
import { canReadChatMessages } from './chat-rooms.js';
import { getMediaAssetByFilename } from './media-assets.js';

/** Authorization for registered media. Returns null for a legacy unregistered file. */
export const canUserReadRegisteredImage = (userId: number, filename: string): boolean | null => {
  const asset = getMediaAssetByFilename(filename);
  if (!asset) return null;
  if (asset.user_id === userId) return true;

  const references = db.prepare(`
    SELECT entity_type, entity_id
    FROM media_asset_references
    WHERE asset_id = ?
  `).all(asset.id) as Array<{ entity_type: string; entity_id: number }>;

  return references.some(reference => {
    if (reference.entity_type === 'chat_message') {
      const message = db.prepare('SELECT chat_id FROM chat_messages WHERE id = ?')
        .get(reference.entity_id) as { chat_id: number | null } | undefined;
      return Boolean(message?.chat_id && canReadChatMessages(userId, message.chat_id));
    }
    if (reference.entity_type === 'newspaper_issue') {
      return Boolean(db.prepare('SELECT 1 FROM newspaper_issues WHERE id = ? AND user_id = ?')
        .get(reference.entity_id, userId));
    }
    if (reference.entity_type === 'user_prompt') {
      return Boolean(db.prepare('SELECT 1 FROM user_prompts WHERE id = ? AND user_id = ?')
        .get(reference.entity_id, userId));
    }
    return false;
  });
};
