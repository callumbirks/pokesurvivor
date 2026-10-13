/**
 * The boundary between friends (HTTP, this module) and live presence and invites (the
 * WebSocket server, phase 3c). The WebSocket server will implement `PresenceSource` from its
 * connected sockets and rooms, and `FriendNotifier` to push friend changes to online users.
 * Until then the defaults report everyone offline and notify nobody.
 */

export type PresenceStatus = 'offline' | 'online' | 'in_lobby' | 'in_game';

export interface PresenceSource {
  statusOf(userIds: readonly string[]): ReadonlyMap<string, PresenceStatus>;
}

export type FriendEvent =
  | { type: 'request_received'; userId: string; fromUserId: string }
  | { type: 'request_accepted'; userId: string; byUserId: string }
  | { type: 'friend_removed'; userId: string; byUserId: string };

export interface FriendNotifier {
  /** Called after the change is committed. Must not throw. */
  notify(event: FriendEvent): void;
}

export const offlinePresence: PresenceSource = {
  statusOf: () => new Map(),
};

export const silentNotifier: FriendNotifier = {
  notify: () => {},
};
