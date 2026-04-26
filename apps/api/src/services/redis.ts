import Redis from 'ioredis';
import { logger } from '../lib/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6399';

let client: Redis | null = null;
let subscriber: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 5) return null; // stop retrying
        return Math.min(times * 200, 2000);
      },
    });

    client.on('error', (err) => {
      logger.warn({ err }, 'Redis connection error');
    });

    client.on('connect', () => {
      logger.info('Redis connected');
    });
  }
  return client;
}

/**
 * Dedicated pub/sub subscriber connection. ioredis cannot mix SUBSCRIBE and
 * regular commands on the same client, so any code using subscribe/psubscribe
 * must call this instead of getRedis().
 */
export function getRedisSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 5) return null;
        return Math.min(times * 200, 2000);
      },
    });

    subscriber.on('error', (err) => {
      logger.warn({ err }, 'Redis subscriber connection error');
    });
  }
  return subscriber;
}

export async function connectRedis(): Promise<boolean> {
  try {
    const redis = getRedis();
    await redis.connect();
    return true;
  } catch (err) {
    logger.warn({ err }, 'Redis unavailable — live messaging disabled');
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => {});
    client = null;
  }
  if (subscriber) {
    await subscriber.quit().catch(() => {});
    subscriber = null;
  }
}

export async function isRedisHealthy(): Promise<boolean> {
  try {
    const redis = getRedis();
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}
