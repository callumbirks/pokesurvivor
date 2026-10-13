// A room: lobby membership, invites, ready checks and the game state machine.
//
//   lobby ──start (owner; every member ready)──▶ loading ──all loaded, or timeout──▶ running
//     ▲                                            │ (nobody loaded)                  │
//     └──────────── results sent ◀── ended ◀───────┴──────── the run ends ◀──────────┘
//
// Members who don't ack "loaded" in time are dropped from the game and stay in the lobby part
// of the room (`inGame: false`) until the run is over.
import { randomBytes } from 'node:crypto';
import {
  MAX_ROOM_MEMBERS,
  type MemberStatus,
  type NoticeCode,
  type RoomPhase,
  type RoomView,
} from '@pokesurvivor/protocol';
import { Game, type GameOutcome, type GamePlayerInfo } from './game.js';
import { loadLoadout, partnerOf, type Partner } from './loadout.js';
import { GameError, type GameServer } from './server.js';
import { getSave } from '../saves/service.js';

export interface Member {
  userId: string;
  username: string;
  status: MemberStatus;
  partner: Partner | null;
  inGame: boolean;
  loaded: boolean;
  /** Pending removal after a disconnect (cleared on reconnect). */
  graceTimer: NodeJS.Timeout | null;
}

interface Invite {
  userId: string;
  username: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const ROOM_ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function newRoomId(): string {
  const bytes = randomBytes(8);
  return [...bytes].map((b) => ROOM_ID_CHARS[b % ROOM_ID_CHARS.length]).join('');
}

export class Room {
  readonly id = newRoomId();
  ownerId: string;
  phase: RoomPhase = 'lobby';
  readonly members = new Map<string, Member>();
  readonly invites = new Map<string, Invite>();
  game: Game | null = null;
  private loadingTimer: NodeJS.Timeout | null = null;
  private loadingDeadline: number | null = null;
  private starting = false;
  closed = false;

  constructor(
    private readonly server: GameServer,
    owner: { userId: string; username: string },
  ) {
    this.ownerId = owner.userId;
    this.addMember(owner.userId, owner.username);
  }

  // ---------------------------------------------------------------- views and messages

  view(): RoomView {
    return {
      id: this.id,
      phase: this.phase,
      ownerId: this.ownerId,
      members: [...this.members.values()].map((m) => ({
        userId: m.userId,
        username: m.username,
        status: m.status,
        connected: this.server.isOnline(m.userId),
        inGame: m.inGame,
        loaded: m.loaded,
        partner: m.partner,
      })),
      invited: [...this.invites.values()].map((i) => i.username),
      maxMembers: MAX_ROOM_MEMBERS,
      blockers: this.blockers(),
      loadingDeadline: this.loadingDeadline,
    };
  }

  /** Members keeping the owner from starting: not ready, busy, offline or without a partner. */
  blockers(): string[] {
    return [...this.members.values()]
      .filter((m) => m.status !== 'ready' || !m.partner || !this.server.isOnline(m.userId))
      .map((m) => m.username);
  }

  /** Sends the room to every member and updates their presence. */
  sync(): void {
    const view = this.view();
    for (const m of this.members.values()) {
      this.server.sessionOf(m.userId)?.send({ type: 'room', room: view });
      this.server.presenceChanged(m.userId);
    }
  }

  notice(code: NoticeCode, usernames: string[], except?: string): void {
    for (const m of this.members.values())
      if (m.userId !== except)
        this.server.sessionOf(m.userId)?.send({ type: 'notice', code, usernames });
  }

  member(userId: string): Member {
    const m = this.members.get(userId);
    if (!m) throw new GameError('not_in_room', 'Not in this room');
    return m;
  }

  private requireOwner(userId: string): void {
    if (userId !== this.ownerId)
      throw new GameError('not_owner', 'Only the room owner can do that');
  }

  // ---------------------------------------------------------------- membership

  addMember(userId: string, username: string): Member {
    const member: Member = {
      userId,
      username,
      status: 'not-ready',
      partner: null,
      inGame: false,
      loaded: false,
      graceTimer: null,
    };
    this.members.set(userId, member);
    this.server.setRoomOf(userId, this);
    void this.refreshPartner(member);
    return member;
  }

  /** Reads the member's partner from their save (shown in the lobby; reloaded at start). */
  async refreshPartner(member: Member): Promise<void> {
    try {
      const partner = partnerOf(await getSave(this.server.db, member.userId));
      if (JSON.stringify(partner) === JSON.stringify(member.partner)) return;
      member.partner = partner;
      if (this.members.get(member.userId) === member) this.sync();
    } catch (err) {
      this.server.log.warn({ err, userId: member.userId }, 'could not read partner');
    }
  }

  invite(fromUserId: string, target: { userId: string; username: string }): void {
    this.member(fromUserId);
    if (this.phase !== 'lobby') throw new GameError('room_busy', 'The game has already started');
    if (this.members.has(target.userId))
      throw new GameError('already_member', 'Already in the room');
    if (this.members.size >= MAX_ROOM_MEMBERS) throw new GameError('room_full', 'The room is full');
    const old = this.invites.get(target.userId);
    if (old) clearTimeout(old.timer);
    const expiresAt = Date.now() + this.server.config.inviteTtlMs;
    const timer = setTimeout(
      () => this.revokeInvite(target.userId),
      this.server.config.inviteTtlMs,
    );
    this.invites.set(target.userId, { ...target, expiresAt, timer });
    const from = this.members.get(fromUserId)?.username ?? '';
    this.server
      .sessionOf(target.userId)
      ?.send({ type: 'invite', roomId: this.id, from, expiresAt });
    this.sync();
  }

  revokeInvite(userId: string, notify = true): void {
    const invite = this.invites.get(userId);
    if (!invite) return;
    clearTimeout(invite.timer);
    this.invites.delete(userId);
    if (notify) this.server.sessionOf(userId)?.send({ type: 'invite.revoked', roomId: this.id });
    if (!this.closed) this.sync();
  }

  /** Accepts an invite. */
  join(userId: string, username: string): void {
    const invite = this.invites.get(userId);
    if (!invite || invite.expiresAt < Date.now())
      throw new GameError('no_invite', 'No pending invite to this room');
    if (this.phase !== 'lobby') throw new GameError('room_busy', 'The game has already started');
    if (this.members.size >= MAX_ROOM_MEMBERS) throw new GameError('room_full', 'The room is full');
    this.revokeInvite(userId, false);
    this.addMember(userId, username);
    this.sync();
  }

  decline(userId: string): void {
    const invite = this.invites.get(userId);
    if (!invite) throw new GameError('no_invite', 'No pending invite to this room');
    this.revokeInvite(userId, false);
    this.server.sessionOf(this.ownerId)?.send({
      type: 'invite.declined',
      roomId: this.id,
      username: invite.username,
    });
  }

  /**
   * A member leaves (or is kicked, or their reconnect grace ran out). Mid-run they're removed
   * from the game (and credited for what they earned). The owner role passes on.
   */
  leave(userId: string, code: NoticeCode = 'player-left'): void {
    const m = this.members.get(userId);
    if (!m) return;
    if (m.graceTimer) clearTimeout(m.graceTimer);
    this.members.delete(userId);
    this.server.setRoomOf(userId, null);
    this.server.sessionOf(userId)?.send({ type: 'room', room: null });
    if (code === 'kicked')
      this.server.sessionOf(userId)?.send({ type: 'notice', code, usernames: [m.username] });
    this.server.presenceChanged(userId);

    if (this.members.size === 0) {
      // The game, if any, ends with everyone gone (and is still credited).
      this.game?.removePlayer(userId);
      this.close();
      return;
    }
    if (this.ownerId === userId) {
      const next =
        [...this.members.values()].find((x) => this.server.isOnline(x.userId)) ??
        [...this.members.values()][0];
      if (next) {
        this.ownerId = next.userId;
        this.notice('owner-changed', [next.username]);
      }
    }
    this.notice(code === 'kicked' ? 'player-removed' : code, [m.username]);
    if (this.phase === 'loading') this.checkLoaded();
    this.game?.removePlayer(userId);
    if (!this.closed) this.sync();
  }

  kick(byUserId: string, userId: string): void {
    this.requireOwner(byUserId);
    if (userId === byUserId) throw new GameError('bad_request', 'Use leave instead');
    this.member(userId);
    this.leave(userId, 'kicked');
  }

  setStatus(userId: string, status: MemberStatus): void {
    const m = this.member(userId);
    m.status = status;
    this.sync();
    if (status === 'ready') void this.refreshPartner(m);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.loadingTimer) clearTimeout(this.loadingTimer);
    for (const userId of [...this.invites.keys()]) this.revokeInvite(userId);
    for (const m of this.members.values()) {
      if (m.graceTimer) clearTimeout(m.graceTimer);
      this.server.setRoomOf(m.userId, null);
      this.server.sessionOf(m.userId)?.send({ type: 'room', room: null });
      this.server.presenceChanged(m.userId);
    }
    this.members.clear();
    this.server.removeRoom(this);
  }

  // ---------------------------------------------------------------- connections

  /** The member's socket closed: keep their place for the reconnect grace. */
  disconnected(userId: string): void {
    const m = this.members.get(userId);
    if (!m) return;
    if (m.inGame && this.game) {
      this.game.disconnect(userId);
      this.notice('player-disconnected', [m.username], userId);
    }
    if (m.graceTimer) clearTimeout(m.graceTimer);
    m.graceTimer = setTimeout(() => {
      m.graceTimer = null;
      if (this.members.get(userId) === m && !this.server.isOnline(userId))
        this.leave(userId, 'player-removed');
    }, this.server.config.reconnectGraceMs);
    this.sync();
  }

  /** The member is back (new socket): resume where they were. */
  reconnected(userId: string): void {
    const m = this.members.get(userId);
    if (!m) return;
    if (m.graceTimer) clearTimeout(m.graceTimer);
    m.graceTimer = null;
    const session = this.server.sessionOf(userId);
    if (!session) return;
    session.send({ type: 'room', room: this.view() });
    if (m.inGame && this.game) {
      if (this.phase === 'loading') {
        session.send({
          type: 'game.loading',
          game: this.game.info,
          deadline: this.loadingDeadline ?? 0,
        });
      } else if (this.phase === 'running') {
        this.game.reconnect(userId, session);
        this.notice('player-reconnected', [m.username], userId);
      }
    }
    this.sync();
  }

  // ---------------------------------------------------------------- the game

  async start(userId: string): Promise<void> {
    this.requireOwner(userId);
    if (this.server.draining) throw new GameError('server_draining', 'The server is restarting');
    if (this.phase !== 'lobby' || this.starting)
      throw new GameError('room_busy', 'The game has already started');
    const blockers = this.blockers();
    if (blockers.length)
      throw new GameError('not_ready', `Waiting for: ${blockers.join(', ')}`, { blockers });

    this.starting = true;
    let players: GamePlayerInfo[];
    try {
      // Loadouts come from the server saves, never from the clients.
      players = await Promise.all(
        [...this.members.values()].map(async (m) => {
          const loadout = await loadLoadout(this.server.db, m.userId);
          if (!loadout) throw new GameError('no_partner', `${m.username} has no partner`);
          return {
            userId: m.userId,
            username: m.username,
            loadout: loadout.config,
            owned: loadout.owned,
          };
        }),
      );
    } finally {
      this.starting = false;
    }
    if (this.closed || this.phase !== 'lobby') return;
    // Someone may have changed their status or left while the saves were read.
    const stillBlocked = this.blockers();
    if (stillBlocked.length)
      throw new GameError('not_ready', `Waiting for: ${stillBlocked.join(', ')}`, {
        blockers: stillBlocked,
      });
    players = players.filter((p) => this.members.has(p.userId));

    for (const userId of [...this.invites.keys()]) this.revokeInvite(userId);
    const game = new Game(
      this.id,
      players,
      this.server.gameSettings,
      (id) => this.server.sessionOf(id),
      (g, outcome) => this.ended(g, outcome),
    );
    this.game = game;
    this.phase = 'loading';
    this.loadingDeadline = Date.now() + this.server.config.loadingTimeoutMs;
    for (const m of this.members.values()) {
      m.inGame = true;
      m.loaded = false;
      this.server.sessionOf(m.userId)?.send({
        type: 'game.loading',
        game: game.info,
        deadline: this.loadingDeadline,
      });
    }
    this.loadingTimer = setTimeout(
      () => this.loadingTimedOut(),
      this.server.config.loadingTimeoutMs,
    );
    this.sync();
  }

  loaded(userId: string, gameId: string): void {
    const m = this.members.get(userId);
    if (!m || this.phase !== 'loading' || this.game?.id !== gameId || !m.inGame) return;
    m.loaded = true;
    this.sync();
    this.checkLoaded();
  }

  private checkLoaded(): void {
    const playing = [...this.members.values()].filter((m) => m.inGame);
    if (playing.length && playing.every((m) => m.loaded)) this.run();
    else if (!playing.length) this.cancelGame();
  }

  /** Unresponsive members are dropped from the game and go back to the lobby part of the room. */
  private loadingTimedOut(): void {
    this.loadingTimer = null;
    if (this.phase !== 'loading') return;
    const dropped = [...this.members.values()].filter((m) => m.inGame && !m.loaded);
    for (const m of dropped) {
      m.inGame = false;
      m.status = 'not-ready';
    }
    if (dropped.length)
      this.notice(
        'dropped-at-loading',
        dropped.map((m) => m.username),
      );
    if ([...this.members.values()].some((m) => m.inGame)) this.run();
    else this.cancelGame();
  }

  private cancelGame(): void {
    if (this.loadingTimer) clearTimeout(this.loadingTimer);
    this.loadingTimer = null;
    this.loadingDeadline = null;
    this.game = null;
    this.phase = 'lobby';
    for (const m of this.members.values()) {
      m.inGame = false;
      m.loaded = false;
    }
    this.notice('game-cancelled', []);
    this.sync();
  }

  private run(): void {
    const game = this.game;
    if (!game || this.phase !== 'loading') return;
    if (this.loadingTimer) clearTimeout(this.loadingTimer);
    this.loadingTimer = null;
    this.loadingDeadline = null;
    this.phase = 'running';
    game.start([...this.members.values()].filter((m) => m.inGame).map((m) => m.userId));
    this.server.addGame(game);
    // Members who disconnected while loading had their grace started already.
    this.sync();
  }

  private ended(game: Game, outcome: GameOutcome): void {
    if (this.game !== game) return;
    this.phase = 'ended';
    this.server.removeGame(game);
    if (!this.closed) this.sync();
    void this.server.record(this.id, outcome).then((results) => {
      for (const p of outcome.players) {
        const m = this.members.get(p.userId);
        if (m) this.server.sessionOf(p.userId)?.send({ type: 'game.results', results });
      }
      if (this.game !== game) return;
      this.game = null;
      if (this.closed) return;
      this.phase = 'lobby';
      for (const m of this.members.values()) {
        m.inGame = false;
        m.loaded = false;
        m.status = 'not-ready';
      }
      this.sync();
      this.server.roomSettled(this);
    });
  }
}
