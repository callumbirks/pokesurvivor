import { and, eq, or, sql } from 'drizzle-orm';
import { findUserByUsername } from '../auth/users.js';
import type { Executor } from '../db/index.js';
import { isUniqueViolation } from '../db/errors.js';
import { friendships } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import type { Favourite } from '../saves/schema.js';
import type { PresenceStatus, PresenceSource } from './presence.js';

/** The row for a pair of users, in either direction. */
function pair(a: string, b: string) {
  return or(
    and(eq(friendships.requesterId, a), eq(friendships.addresseeId, b)),
    and(eq(friendships.requesterId, b), eq(friendships.addresseeId, a)),
  );
}

async function resolveOther(db: Executor, userId: string, username: string): Promise<string> {
  const other = await findUserByUsername(db, username);
  if (!other) throw new ApiError(404, 'user_not_found', `No user ${username}`);
  if (other.id === userId) throw new ApiError(400, 'cannot_friend_self');
  return other.id;
}

export interface FriendChange {
  /** The other user's id, for notifications. */
  otherUserId: string;
}

/**
 * Sends a friend request. If the other user already sent one to us, this accepts it instead.
 */
export async function sendFriendRequest(
  db: Executor,
  userId: string,
  username: string,
): Promise<FriendChange & { status: 'pending' | 'accepted' }> {
  const otherUserId = await resolveOther(db, userId, username);
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(friendships)
        .where(pair(userId, otherUserId))
        .for('update');
      if (existing?.status === 'accepted') throw new ApiError(409, 'already_friends');
      if (existing?.requesterId === userId) throw new ApiError(409, 'request_already_sent');
      if (existing) {
        await tx
          .update(friendships)
          .set({ status: 'accepted', acceptedAt: sql`now()` })
          .where(eq(friendships.id, existing.id));
        return { otherUserId, status: 'accepted' as const };
      }
      await tx.insert(friendships).values({ requesterId: userId, addresseeId: otherUserId });
      return { otherUserId, status: 'pending' as const };
    });
  } catch (err) {
    // Both users sent a request at the same moment; one of them wins the unique index.
    if (isUniqueViolation(err)) throw new ApiError(409, 'request_already_sent');
    throw err;
  }
}

/** Accepts a pending request that `username` sent to `userId`. */
export async function acceptFriendRequest(
  db: Executor,
  userId: string,
  username: string,
): Promise<FriendChange> {
  const otherUserId = await resolveOther(db, userId, username);
  const updated = await db
    .update(friendships)
    .set({ status: 'accepted', acceptedAt: sql`now()` })
    .where(
      and(
        eq(friendships.requesterId, otherUserId),
        eq(friendships.addresseeId, userId),
        eq(friendships.status, 'pending'),
      ),
    )
    .returning({ id: friendships.id });
  if (updated.length === 0) throw new ApiError(404, 'request_not_found');
  return { otherUserId };
}

/** Declines a pending request that `username` sent to `userId`. */
export async function declineFriendRequest(
  db: Executor,
  userId: string,
  username: string,
): Promise<FriendChange> {
  const otherUserId = await resolveOther(db, userId, username);
  const deleted = await db
    .delete(friendships)
    .where(
      and(
        eq(friendships.requesterId, otherUserId),
        eq(friendships.addresseeId, userId),
        eq(friendships.status, 'pending'),
      ),
    )
    .returning({ id: friendships.id });
  if (deleted.length === 0) throw new ApiError(404, 'request_not_found');
  return { otherUserId };
}

/** Removes a friend, or cancels a request `userId` sent. */
export async function removeFriend(
  db: Executor,
  userId: string,
  username: string,
): Promise<FriendChange & { wasFriend: boolean }> {
  const otherUserId = await resolveOther(db, userId, username);
  const deleted = await db
    .delete(friendships)
    .where(
      and(
        pair(userId, otherUserId),
        or(eq(friendships.status, 'accepted'), eq(friendships.requesterId, userId)),
      ),
    )
    .returning({ status: friendships.status });
  const [row] = deleted;
  if (!row) throw new ApiError(404, 'friend_not_found');
  return { otherUserId, wasFriend: row.status === 'accepted' };
}

/** Ids of the user's accepted friends. */
export async function friendIds(db: Executor, userId: string): Promise<string[]> {
  const rows = await db
    .select({
      id: sql<string>`case when ${friendships.requesterId} = ${userId} then ${friendships.addresseeId} else ${friendships.requesterId} end`,
    })
    .from(friendships)
    .where(
      and(
        or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId)),
        eq(friendships.status, 'accepted'),
      ),
    );
  return rows.map((r) => r.id);
}

export interface FriendSummary {
  username: string;
  partner: { dex: number; shiny: boolean } | null;
  favourites: Favourite[];
  title: string | null;
}

export interface FriendList {
  friends: (FriendSummary & { since: string; presence: PresenceStatus })[];
  /** Requests others sent to this user. */
  incoming: (FriendSummary & { sentAt: string })[];
  /** Requests this user sent. */
  outgoing: (FriendSummary & { sentAt: string })[];
}

interface FriendRow extends Record<string, unknown> {
  other_id: string;
  username: string;
  status: 'pending' | 'accepted';
  outgoing: boolean;
  created_at: Date | string;
  accepted_at: Date | string | null;
  partner_dex: number | null;
  partner_shiny: boolean | null;
  favourites: Favourite[] | null;
  title: string | null;
}

export async function listFriends(
  db: Executor,
  userId: string,
  presence: PresenceSource,
): Promise<FriendList> {
  const rows = await db.execute<FriendRow>(sql`
    select o.id as other_id, o.username, f.status,
           f.requester_id = ${userId} as outgoing,
           f.created_at, f.accepted_at,
           s.partner_dex, s.partner_shiny,
           s.data -> 'profile' -> 'favourites' as favourites,
           s.data -> 'profile' ->> 'title' as title
    from friendships f
    join users o on o.id = case when f.requester_id = ${userId} then f.addressee_id else f.requester_id end
    left join saves s on s.user_id = o.id
    where f.requester_id = ${userId} or f.addressee_id = ${userId}
    order by lower(o.username)
  `);

  const statuses = presence.statusOf(
    rows.filter((r) => r.status === 'accepted').map((r) => r.other_id),
  );
  const summary = (r: FriendRow): FriendSummary => ({
    username: r.username,
    partner: r.partner_dex === null ? null : { dex: r.partner_dex, shiny: !!r.partner_shiny },
    favourites: r.favourites ?? [],
    title: r.title,
  });
  const iso = (value: Date | string) => new Date(value).toISOString();

  const list: FriendList = { friends: [], incoming: [], outgoing: [] };
  for (const r of rows) {
    if (r.status === 'accepted')
      list.friends.push({
        ...summary(r),
        since: iso(r.accepted_at ?? r.created_at),
        presence: statuses.get(r.other_id) ?? 'offline',
      });
    else
      (r.outgoing ? list.outgoing : list.incoming).push({
        ...summary(r),
        sentAt: iso(r.created_at),
      });
  }
  return list;
}
