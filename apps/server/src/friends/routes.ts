import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAuthHooks, currentUser } from '../auth/plugin.js';
import type { Database } from '../db/index.js';
import { parseBody } from '../http/errors.js';
import type { FriendNotifier, PresenceSource } from './presence.js';
import {
  acceptFriendRequest,
  declineFriendRequest,
  listFriends,
  removeFriend,
  sendFriendRequest,
} from './service.js';

export interface FriendRoutesOptions {
  db: Database;
  secureCookies: boolean;
  presence: PresenceSource;
  notifier: FriendNotifier;
  rateLimit: { max: number; timeWindowMs: number };
}

// Any string: an unknown or invalid name is a 404 from the lookup.
const usernameParam = z.object({ username: z.string().min(1).max(64) });

export function friendRoutes(app: FastifyInstance, opts: FriendRoutesOptions): void {
  const { db, presence, notifier } = opts;
  const { requireUser } = createAuthHooks(opts);
  const rateLimit = { max: opts.rateLimit.max, timeWindow: opts.rateLimit.timeWindowMs };

  app.get('/api/friends', { preHandler: requireUser }, (request) =>
    listFriends(db, currentUser(request).id, presence),
  );

  app.post(
    '/api/friends/requests',
    { preHandler: requireUser, config: { rateLimit } },
    async (request, reply) => {
      const { username } = parseBody(usernameParam, request.body);
      const userId = currentUser(request).id;
      const { otherUserId, status } = await sendFriendRequest(db, userId, username);
      notifier.notify(
        status === 'accepted'
          ? { type: 'request_accepted', userId: otherUserId, byUserId: userId }
          : { type: 'request_received', userId: otherUserId, fromUserId: userId },
      );
      return reply.status(status === 'accepted' ? 200 : 201).send({ status });
    },
  );

  app.post(
    '/api/friends/requests/:username/accept',
    { preHandler: requireUser },
    async (request) => {
      const { username } = parseBody(usernameParam, request.params);
      const userId = currentUser(request).id;
      const { otherUserId } = await acceptFriendRequest(db, userId, username);
      notifier.notify({ type: 'request_accepted', userId: otherUserId, byUserId: userId });
      return { status: 'accepted' };
    },
  );

  app.post(
    '/api/friends/requests/:username/decline',
    { preHandler: requireUser },
    async (request, reply) => {
      const { username } = parseBody(usernameParam, request.params);
      await declineFriendRequest(db, currentUser(request).id, username);
      return reply.status(204).send();
    },
  );

  app.delete('/api/friends/:username', { preHandler: requireUser }, async (request, reply) => {
    const { username } = parseBody(usernameParam, request.params);
    const userId = currentUser(request).id;
    const { otherUserId, wasFriend } = await removeFriend(db, userId, username);
    if (wasFriend)
      notifier.notify({ type: 'friend_removed', userId: otherUserId, byUserId: userId });
    return reply.status(204).send();
  });
}
