import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import type { Database, Transaction } from '../db/index.js';
import { gameRoomMembers, gameRooms, gameSaves } from '../db/schema.js';
import { isUniqueViolation } from '../db/errors.js';
import type { SavedRoom } from './room.js';

export const LIVE_LEASE_MS = 30_000;

/**
 * Room reservations fence codes and membership across server instances (a lobby handed over in
 * a deploy, a crash lease), and saved games (`game_saves`) carry running games across a restart.
 */
export class RoomRegistry {
  readonly instanceId = randomUUID();
  constructor(private readonly db: Database) {}

  async cleanup(): Promise<void> {
    await this.db.delete(gameRooms).where(lte(gameRooms.expiresAt, new Date()));
  }

  async renew(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db
      .update(gameRooms)
      .set({ expiresAt: new Date(Date.now() + LIVE_LEASE_MS) })
      .where(and(eq(gameRooms.instanceId, this.instanceId), inArray(gameRooms.id, ids)));
  }

  private async reclaimExpiredMembership(tx: Transaction, userId: string): Promise<void> {
    // Cleanup is periodic. Reclaim this user's expired reservation immediately so the
    // 30-second crash lease doesn't turn into a lease + cleanup-interval lockout.
    await tx
      .delete(gameRooms)
      .where(
        and(
          lte(gameRooms.expiresAt, new Date()),
          inArray(
            gameRooms.id,
            tx
              .select({ roomId: gameRoomMembers.roomId })
              .from(gameRoomMembers)
              .where(eq(gameRoomMembers.userId, userId)),
          ),
        ),
      );
  }

  async create(id: string, userId: string): Promise<'ok' | 'code_taken' | 'member_taken'> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.reclaimExpiredMembership(tx, userId);
        const inserted = await tx
          .insert(gameRooms)
          .values({
            id,
            instanceId: this.instanceId,
            expiresAt: new Date(Date.now() + LIVE_LEASE_MS),
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted.length) return 'code_taken';
        await tx.insert(gameRoomMembers).values({ roomId: id, userId });
        return 'ok';
      });
    } catch (err) {
      if (isUniqueViolation(err)) return 'member_taken';
      throw err;
    }
  }

  async membership(userId: string) {
    const [row] = await this.db
      .select({ room: gameRooms })
      .from(gameRoomMembers)
      .innerJoin(gameRooms, eq(gameRoomMembers.roomId, gameRooms.id))
      .where(and(eq(gameRoomMembers.userId, userId), gt(gameRooms.expiresAt, new Date())));
    return row?.room ?? null;
  }

  async room(id: string) {
    const [row] = await this.db
      .select()
      .from(gameRooms)
      .where(and(eq(gameRooms.id, id), gt(gameRooms.expiresAt, new Date())));
    return row ?? null;
  }

  /** Move only a membership this process already owns; never steal from the old container. */
  async join(userId: string, id: string, previousId?: string): Promise<boolean> {
    try {
      await this.db.transaction(async (tx) => {
        await this.reclaimExpiredMembership(tx, userId);
        if (previousId)
          await tx
            .delete(gameRoomMembers)
            .where(and(eq(gameRoomMembers.userId, userId), eq(gameRoomMembers.roomId, previousId)));
        await tx.insert(gameRoomMembers).values({ userId, roomId: id });
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async leave(userId: string, roomId: string): Promise<void> {
    // Conditional room id prevents a delayed old callback from deleting a newer membership.
    await this.db
      .delete(gameRoomMembers)
      .where(
        and(
          eq(gameRoomMembers.userId, userId),
          eq(gameRoomMembers.roomId, roomId),
          inArray(
            gameRoomMembers.roomId,
            this.db
              .select({ id: gameRooms.id })
              .from(gameRooms)
              .where(eq(gameRooms.instanceId, this.instanceId)),
          ),
        ),
      );
  }

  async remove(id: string): Promise<void> {
    await this.db
      .delete(gameRooms)
      .where(and(eq(gameRooms.id, id), eq(gameRooms.instanceId, this.instanceId)));
  }

  /** Publish only after lobby requests settle. Payload and the owner's release are atomic. */
  async handoff(room: SavedRoom, ttlMs: number): Promise<void> {
    const updated = await this.db
      .update(gameRooms)
      .set({
        instanceId: null,
        handoff: room,
        expiresAt: new Date(Date.now() + ttlMs),
      })
      .where(and(eq(gameRooms.id, room.id), eq(gameRooms.instanceId, this.instanceId)))
      .returning();
    if (!updated.length) throw new Error(`Lost ownership of room ${room.id}`);
  }

  /**
   * Saves running games for the next server (stop-first deploys) and lets go of their rooms in
   * one transaction. The rooms' reservations stay for `ttlMs`, without a lobby payload: nobody
   * adopts them as lobbies; the server that restores a game takes its room back (`claimRoom`).
   */
  async saveGames(rows: (typeof gameSaves.$inferInsert)[], ttlMs: number): Promise<void> {
    if (!rows.length) return;
    await this.db.transaction(async (tx) => {
      await tx.insert(gameSaves).values(rows);
      await tx
        .update(gameRooms)
        .set({ instanceId: null, handoff: null, expiresAt: new Date(Date.now() + ttlMs) })
        .where(
          and(
            eq(gameRooms.instanceId, this.instanceId),
            inArray(
              gameRooms.id,
              rows.map((r) => r.roomId),
            ),
          ),
        );
    });
  }

  /** Takes saved games (all of them, or one room's): each is claimed by exactly one server. */
  async claimSaves(roomId?: string): Promise<(typeof gameSaves.$inferSelect)[]> {
    return this.db
      .delete(gameSaves)
      .where(roomId === undefined ? undefined : eq(gameSaves.roomId, roomId))
      .returning();
  }

  /**
   * Owns a restored game's room. Its reservation may have expired (the new server took long to
   * start): then it's made again, with the members nobody else has reserved since.
   */
  async claimRoom(id: string, userIds: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const lease = { instanceId: this.instanceId, handoff: null, expiresAt: new Date(Date.now() + LIVE_LEASE_MS) };
      await tx
        .insert(gameRooms)
        .values({ id, ...lease })
        .onConflictDoUpdate({ target: gameRooms.id, set: lease });
      if (userIds.length)
        await tx
          .insert(gameRoomMembers)
          .values(userIds.map((userId) => ({ userId, roomId: id })))
          .onConflictDoNothing();
    });
  }

  /** Row lock selects exactly one adopter. Active reservations remain; payload is consumed. */
  async adopt(id: string): Promise<SavedRoom | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(gameRooms)
        .where(
          and(
            eq(gameRooms.id, id),
            isNull(gameRooms.instanceId),
            gt(gameRooms.expiresAt, new Date()),
          ),
        )
        .for('update');
      if (!row?.handoff) return null;
      const members = await tx.select().from(gameRoomMembers).where(eq(gameRoomMembers.roomId, id));
      const retained = new Set(members.map((m) => m.userId));
      const saved = {
        ...row.handoff,
        members: row.handoff.members.filter((m) => retained.has(m.userId)),
      };
      if (!saved.members.length) {
        await tx.delete(gameRooms).where(eq(gameRooms.id, id));
        return null;
      }
      if (!retained.has(saved.ownerId)) saved.ownerId = saved.members[0]!.userId;
      await tx
        .update(gameRooms)
        .set({
          instanceId: this.instanceId,
          handoff: null,
          expiresAt: new Date(Date.now() + LIVE_LEASE_MS),
        })
        .where(eq(gameRooms.id, id));
      return saved;
    });
  }
}
