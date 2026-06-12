import { Hono, type Context } from 'hono';
import {
  getFriends,
  getFriendById,
  getFriendCount,
  getLineAccountById,
  addTagToFriend,
  removeTagFromFriend,
  getFriendTags,
  getScenarios,
  enrollFriendInScenario,
  jstNow,
} from '@line-crm/db';
import type { Friend as DbFriend, Tag as DbTag } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage } from '../services/step-delivery.js';
import type { Env } from '../index.js';

const friends = new Hono<Env>();

const FOLLOWER_IMPORT_SOURCE = 'line_followers_import';
const DEFAULT_FOLLOWER_PAGE_LIMIT = 1000;
const MAX_FOLLOWER_PAGE_LIMIT = 1000;
const DEFAULT_PROFILE_ENRICH_LIMIT = 50;
const MAX_PROFILE_ENRICH_LIMIT = 100;
const UPSERT_CHUNK_SIZE = 100;

type LineApiError = Error & { status?: number; body?: string };
type ImportFollowersBody = {
  lineAccountId?: string | null;
  start?: string | null;
  pageLimit?: number;
  maxPages?: number;
  maxUsers?: number;
  dryRun?: boolean;
};
type EnrichProfilesBody = {
  lineAccountId?: string | null;
  limit?: number;
  onlyMissingName?: boolean;
  dryRun?: boolean;
};

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function toBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function requireImportRole(c: Context<Env>) {
  const staff = c.get('staff');
  if (staff?.role !== 'owner' && staff?.role !== 'admin') {
    return c.json({ success: false, error: 'Owner or admin role is required' }, 403);
  }
  return null;
}

async function resolveLineClient(
  c: Context<Env>,
  lineAccountId?: string | null,
): Promise<{ lineClient: LineClient; lineAccountId: string | null; source: 'line_account' | 'env' }> {
  if (lineAccountId) {
    const account = await getLineAccountById(c.env.DB, lineAccountId);
    if (!account) {
      throw Object.assign(new Error('LINE account not found'), { status: 404 });
    }
    return {
      lineClient: new LineClient(account.channel_access_token),
      lineAccountId,
      source: 'line_account',
    };
  }

  if (!c.env.LINE_CHANNEL_ACCESS_TOKEN) {
    throw Object.assign(new Error('LINE_CHANNEL_ACCESS_TOKEN is not configured'), { status: 500 });
  }

  return {
    lineClient: new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN),
    lineAccountId: null,
    source: 'env',
  };
}

function lineApiErrorResponse(c: Context<Env>, err: unknown) {
  const lineErr = err as LineApiError;
  const parsedStatus = lineErr?.status
    ?? Number(lineErr?.message?.match(/LINE API error:\s*(\d{3})/)?.[1] ?? 0)
    ?? undefined;

  if (parsedStatus === 403) {
    return c.json({
      success: false,
      error: 'LINE followers API returned 403. The Official Account must be verified or premium to fetch all follower IDs.',
      reason: 'verified_or_premium_required',
      detail: lineErr.body ?? lineErr.message,
    }, 403);
  }
  if (parsedStatus === 404) {
    return c.json({ success: false, error: lineErr.message }, 404);
  }
  return c.json({ success: false, error: lineErr?.message ?? 'Internal server error' }, 500);
}

async function upsertFollowerIds(
  db: D1Database,
  lineUserIds: string[],
  lineAccountId: string | null,
  importedAt: string,
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  const metadata = JSON.stringify({
    line_followers_import_source: FOLLOWER_IMPORT_SOURCE,
    line_followers_imported_at: importedAt,
    line_followers_import_account_id: lineAccountId,
  });

  for (let i = 0; i < lineUserIds.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = lineUserIds.slice(i, i + UPSERT_CHUNK_SIZE);
    if (chunk.length === 0) continue;

    const placeholders = chunk.map(() => '?').join(',');
    const existingRow = await db
      .prepare(`SELECT COUNT(*) as count FROM friends WHERE line_user_id IN (${placeholders})`)
      .bind(...chunk)
      .first<{ count: number }>();
    const existingCount = existingRow?.count ?? 0;
    created += chunk.length - existingCount;
    updated += existingCount;

    const now = importedAt;
    const statements = chunk.map((lineUserId) => db
      .prepare(
        `INSERT INTO friends (id, line_user_id, is_following, line_account_id, metadata, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(line_user_id) DO UPDATE SET
           is_following = 1,
           line_account_id = COALESCE(friends.line_account_id, excluded.line_account_id),
           metadata = json_patch(COALESCE(NULLIF(friends.metadata, ''), '{}'), excluded.metadata),
           updated_at = excluded.updated_at`,
      )
      .bind(crypto.randomUUID(), lineUserId, lineAccountId, metadata, now, now));

    await db.batch(statements);
  }

  return { created, updated };
}

async function getFollowerIds(
  lineClient: LineClient,
  options: { start?: string; limit?: number },
): Promise<{ userIds: string[]; next?: string }> {
  const params = new URLSearchParams();
  if (options.start) params.set('start', options.start);
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  const { data } = await lineClient.request(
    'GET',
    `/v2/bot/followers/ids${query ? `?${query}` : ''}`,
  );
  return data as { userIds: string[]; next?: string };
}

/** Convert a D1 snake_case Friend row to the shared camelCase shape */
function serializeFriend(row: DbFriend) {
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
    statusMessage: row.status_message,
    isFollowing: Boolean(row.is_following),
    metadata: JSON.parse(row.metadata || '{}'),
    refCode: (row as unknown as Record<string, unknown>).ref_code as string | null,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Convert a D1 snake_case Tag row to the shared camelCase shape */
function serializeTag(row: DbTag) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

// GET /api/friends - list with pagination
friends.get('/api/friends', async (c) => {
  try {
    const limit = Number(c.req.query('limit') ?? '50');
    const offset = Number(c.req.query('offset') ?? '0');
    const tagId = c.req.query('tagId');
    const lineAccountId = c.req.query('lineAccountId');
    const search = c.req.query('search');

    const db = c.env.DB;

    // Build WHERE conditions
    const conditions: string[] = [];
    const binds: unknown[] = [];
    if (tagId) {
      conditions.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
      binds.push(tagId);
    }
    if (lineAccountId) {
      conditions.push('f.line_account_id = ?');
      binds.push(lineAccountId);
    }
    if (search) {
      conditions.push('f.display_name LIKE ?');
      binds.push(`%${search}%`);
    }
    // Metadata filters: ?metadata.key=value (e.g. ?metadata.monthly_cost=〜100万円)
    const url = new URL(c.req.url);
    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith('metadata.')) {
        const metaKey = key.slice('metadata.'.length);
        conditions.push(`json_extract(f.metadata, '$.' || ?) = ?`);
        binds.push(metaKey, value);
      }
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM friends f ${where}`);
    const totalRow = await (binds.length > 0 ? countStmt.bind(...binds) : countStmt).first<{ count: number }>();
    const total = totalRow?.count ?? 0;

    const listStmt = db.prepare(
      `SELECT f.* FROM friends f ${where} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    );
    const listBinds = [...binds, limit, offset];
    const listResult = await listStmt.bind(...listBinds).all<DbFriend>();
    const items = listResult.results;

    // Fetch tags for each friend in parallel so the list response includes tags
    const itemsWithTags = await Promise.all(
      items.map(async (friend) => {
        const tags = await getFriendTags(db, friend.id);
        return { ...serializeFriend(friend), tags: tags.map(serializeTag) };
      }),
    );

    return c.json({
      success: true,
      data: {
        items: itemsWithTags,
        total,
        page: Math.floor(offset / limit) + 1,
        limit,
        hasNextPage: offset + limit < total,
      },
    });
  } catch (err) {
    console.error('GET /api/friends error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/count - friend count (must be before /:id)
friends.get('/api/friends/count', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    let count: number;
    if (lineAccountId) {
      const row = await c.env.DB.prepare('SELECT COUNT(*) as count FROM friends WHERE is_following = 1 AND line_account_id = ?')
        .bind(lineAccountId).first<{ count: number }>();
      count = row?.count ?? 0;
    } else {
      count = await getFriendCount(c.env.DB);
    }
    return c.json({ success: true, data: { count } });
  } catch (err) {
    console.error('GET /api/friends/count error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/import-followers - import all current LINE follower IDs
friends.post('/api/friends/import-followers', async (c) => {
  const roleError = requireImportRole(c);
  if (roleError) return roleError;

  try {
    const body = await c.req.json<ImportFollowersBody>().catch(() => ({} as ImportFollowersBody));

    const pageLimit = toBoundedInt(
      body.pageLimit,
      DEFAULT_FOLLOWER_PAGE_LIMIT,
      1,
      MAX_FOLLOWER_PAGE_LIMIT,
    );
    const maxPages = toBoundedInt(body.maxPages, 100, 1, 500);
    const maxUsers = body.maxUsers == null
      ? null
      : toBoundedInt(body.maxUsers, 1, 1, 100_000);
    const dryRun = Boolean(body.dryRun);
    const initialStart = typeof body.start === 'string' && body.start.length > 0
      ? body.start
      : undefined;

    const { lineClient, lineAccountId, source } = await resolveLineClient(c, body.lineAccountId ?? null);
    const importedAt = jstNow();
    const importedIds = new Set<string>();
    let start = initialStart;
    let next: string | undefined;
    let pages = 0;
    let created = 0;
    let updated = 0;

    do {
      const response = await getFollowerIds(lineClient, { start, limit: pageLimit });
      pages += 1;
      next = response.next;

      const remaining = maxUsers == null ? response.userIds.length : maxUsers - importedIds.size;
      const ids = response.userIds.slice(0, Math.max(remaining, 0));
      for (const id of ids) importedIds.add(id);

      if (!dryRun && ids.length > 0) {
        const result = await upsertFollowerIds(c.env.DB, ids, lineAccountId, importedAt);
        created += result.created;
        updated += result.updated;
      }

      if (maxUsers != null && importedIds.size >= maxUsers) break;
      start = next;
    } while (next && pages < maxPages);

    const stoppedByMaxPages = Boolean(next) && pages >= maxPages;
    const stoppedByMaxUsers = maxUsers != null && importedIds.size >= maxUsers;

    return c.json({
      success: true,
      data: {
        dryRun,
        source,
        lineAccountId,
        fetched: importedIds.size,
        created,
        updated,
        pages,
        pageLimit,
        next: next ?? null,
        completed: !next || stoppedByMaxUsers,
        stoppedByMaxPages,
        stoppedByMaxUsers,
        importedAt,
      },
    });
  } catch (err) {
    console.error('POST /api/friends/import-followers error:', err);
    return lineApiErrorResponse(c, err);
  }
});

// POST /api/friends/enrich-profiles - fill display names in small safe batches
friends.post('/api/friends/enrich-profiles', async (c) => {
  const roleError = requireImportRole(c);
  if (roleError) return roleError;

  try {
    const body = await c.req.json<EnrichProfilesBody>().catch(() => ({} as EnrichProfilesBody));

    const limit = toBoundedInt(
      body.limit,
      DEFAULT_PROFILE_ENRICH_LIMIT,
      1,
      MAX_PROFILE_ENRICH_LIMIT,
    );
    const onlyMissingName = body.onlyMissingName !== false;
    const dryRun = Boolean(body.dryRun);
    const { lineClient, lineAccountId, source } = await resolveLineClient(c, body.lineAccountId ?? null);

    const conditions = ['is_following = 1'];
    const binds: unknown[] = [];
    if (lineAccountId) {
      conditions.push('line_account_id = ?');
      binds.push(lineAccountId);
    }
    if (onlyMissingName) {
      conditions.push('(display_name IS NULL OR display_name = \'\')');
    }

    const result = await c.env.DB
      .prepare(
        `SELECT * FROM friends
         WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .bind(...binds, limit)
      .all<DbFriend>();

    let enriched = 0;
    let markedUnfollowed = 0;
    const failed: Array<{ friendId: string; lineUserId: string; status?: number; message: string }> = [];
    const enrichedAt = jstNow();

    for (const friend of result.results) {
      try {
        const profile = await lineClient.getProfile(friend.line_user_id);
        if (!dryRun) {
          const existingMetadata = parseJsonObject(friend.metadata);
          const metadata = JSON.stringify({
            ...existingMetadata,
            line_profile_enriched_at: enrichedAt,
          });
          await c.env.DB
            .prepare(
              `UPDATE friends
               SET display_name = ?,
                   picture_url = ?,
                   status_message = ?,
                   metadata = ?,
                   updated_at = ?
               WHERE id = ?`,
            )
            .bind(
              profile.displayName ?? null,
              profile.pictureUrl ?? null,
              profile.statusMessage ?? null,
              metadata,
              enrichedAt,
              friend.id,
            )
            .run();
        }
        enriched += 1;
      } catch (err) {
        const lineErr = err as LineApiError;
        const status = lineErr.status
          ?? Number(lineErr.message?.match(/LINE API error:\s*(\d{3})/)?.[1] ?? 0)
          ?? undefined;
        failed.push({
          friendId: friend.id,
          lineUserId: friend.line_user_id,
          status,
          message: lineErr.message,
        });

        if (!dryRun && (status === 403 || status === 404)) {
          const existingMetadata = parseJsonObject(friend.metadata);
          await c.env.DB
            .prepare(
              `UPDATE friends
               SET is_following = 0,
                   metadata = ?,
                   updated_at = ?
               WHERE id = ?`,
            )
            .bind(JSON.stringify({
              ...existingMetadata,
              line_profile_error_at: enrichedAt,
              line_profile_error_status: status ?? null,
            }), enrichedAt, friend.id)
            .run();
          markedUnfollowed += 1;
        }
      }
    }

    const remainingRow = await c.env.DB
      .prepare(
        `SELECT COUNT(*) as count FROM friends
         WHERE is_following = 1
           ${lineAccountId ? 'AND line_account_id = ?' : ''}
           ${onlyMissingName ? 'AND (display_name IS NULL OR display_name = \'\')' : ''}`,
      )
      .bind(...(lineAccountId ? [lineAccountId] : []))
      .first<{ count: number }>();

    return c.json({
      success: true,
      data: {
        dryRun,
        source,
        lineAccountId,
        scanned: result.results.length,
        enriched,
        markedUnfollowed,
        failedCount: failed.length,
        failed: failed.slice(0, 10),
        remaining: remainingRow?.count ?? 0,
        enrichedAt,
      },
    });
  } catch (err) {
    console.error('POST /api/friends/enrich-profiles error:', err);
    return lineApiErrorResponse(c, err);
  }
});

// GET /api/friends/ref-stats - ref code attribution stats
friends.get('/api/friends/ref-stats', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const where = lineAccountId ? 'WHERE line_account_id = ?' : 'WHERE ref_code IS NOT NULL';
    const binds = lineAccountId ? [lineAccountId] : [];
    const stmt = c.env.DB.prepare(
      `SELECT ref_code, COUNT(*) as count FROM friends ${where} AND ref_code IS NOT NULL GROUP BY ref_code ORDER BY count DESC`,
    );
    const result = await (binds.length > 0 ? stmt.bind(...binds) : stmt).all<{ ref_code: string; count: number }>();
    const total = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM friends ${lineAccountId ? 'WHERE line_account_id = ?' : ''} ${lineAccountId ? 'AND' : 'WHERE'} ref_code IS NOT NULL`,
    ).bind(...(lineAccountId ? [lineAccountId] : [])).first<{ count: number }>();
    return c.json({
      success: true,
      data: {
        routes: result.results.map((r) => ({ refCode: r.ref_code, friendCount: r.count })),
        totalWithRef: total?.count ?? 0,
      },
    });
  } catch (err) {
    console.error('GET /api/friends/ref-stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id - get single friend with tags
friends.get('/api/friends/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const db = c.env.DB;

    const [friend, tags] = await Promise.all([
      getFriendById(db, id),
      getFriendTags(db, id),
    ]);

    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        ...serializeFriend(friend),
        tags: tags.map(serializeTag),
      },
    });
  } catch (err) {
    console.error('GET /api/friends/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/tags - add tag
friends.post('/api/friends/:id/tags', async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{ tagId: string }>();

    if (!body.tagId) {
      return c.json({ success: false, error: 'tagId is required' }, 400);
    }

    const db = c.env.DB;
    await addTagToFriend(db, friendId, body.tagId);

    // Enroll in tag_added scenarios that match this tag
    const allScenarios = await getScenarios(db);
    for (const scenario of allScenarios) {
      if (scenario.trigger_type === 'tag_added' && scenario.is_active && scenario.trigger_tag_id === body.tagId) {
        const existing = await db
          .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
          .bind(friendId, scenario.id)
          .first();
        if (!existing) {
          await enrollFriendInScenario(db, friendId, scenario.id);
        }
      }
    }

    // イベントバス発火: tag_change
    await fireEvent(db, 'tag_change', { friendId, eventData: { tagId: body.tagId, action: 'add' } });

    return c.json({ success: true, data: null }, 201);
  } catch (err) {
    console.error('POST /api/friends/:id/tags error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/friends/:id/tags/:tagId - remove tag
friends.delete('/api/friends/:id/tags/:tagId', async (c) => {
  try {
    const friendId = c.req.param('id');
    const tagId = c.req.param('tagId');

    await removeTagFromFriend(c.env.DB, friendId, tagId);

    // イベントバス発火: tag_change
    await fireEvent(c.env.DB, 'tag_change', { friendId, eventData: { tagId, action: 'remove' } });

    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/friends/:id/tags/:tagId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/friends/:id/metadata - merge metadata fields
friends.put('/api/friends/:id/metadata', async (c) => {
  try {
    const friendId = c.req.param('id');
    const db = c.env.DB;

    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const body = await c.req.json<Record<string, unknown>>();
    const existing = JSON.parse(friend.metadata || '{}');
    const merged = { ...existing, ...body };
    const now = jstNow();

    await db
      .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(merged), now, friendId)
      .run();

    const updated = await getFriendById(db, friendId);
    const tags = await getFriendTags(db, friendId);

    return c.json({
      success: true,
      data: {
        ...serializeFriend(updated!),
        tags: tags.map(serializeTag),
      },
    });
  } catch (err) {
    console.error('PUT /api/friends/:id/metadata error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id/messages - get message history
friends.get('/api/friends/:id/messages', async (c) => {
  try {
    const friendId = c.req.param('id');
    const result = await c.env.DB
      .prepare(
        `SELECT id, direction, message_type as messageType, content, created_at as createdAt
         FROM messages_log WHERE friend_id = ? ORDER BY created_at ASC LIMIT 200`,
      )
      .bind(friendId)
      .all<{ id: string; direction: string; messageType: string; content: string; createdAt: string }>();
    return c.json({ success: true, data: result.results });
  } catch (err) {
    console.error('GET /api/friends/:id/messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/messages - send message to friend
friends.post('/api/friends/:id/messages', async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{
      messageType?: string;
      content: string;
      altText?: string;
    }>();

    if (!body.content) {
      return c.json({ success: false, error: 'content is required' }, 400);
    }

    const db = c.env.DB;
    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    // Resolve access token from friend's account (multi-account support)
    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    if ((friend as unknown as Record<string, unknown>).line_account_id) {
      const account = await getLineAccountById(db, (friend as unknown as Record<string, unknown>).line_account_id as string);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);
    const messageType = body.messageType ?? 'text';

    // Auto-wrap URLs with tracking links (text with URLs → Flex with button)
    const { autoTrackContent } = await import('../services/auto-track.js');
    const tracked = await autoTrackContent(
      db, messageType, body.content,
      c.env.WORKER_URL || new URL(c.req.url).origin,
    );

    const message = buildMessage(tracked.messageType, tracked.content, body.altText);
    await lineClient.pushMessage(friend.line_user_id, [message]);

    // Log outgoing message
    const logId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'manual', ?)`,
      )
      .bind(logId, friend.id, messageType, body.content, jstNow())
      .run();

    return c.json({ success: true, data: { messageId: logId } });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('POST /api/friends/:id/messages error:', errMsg);
    return c.json({ success: false, error: errMsg }, 500);
  }
});

export { friends };
