import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const LIMITS = { reqPerMin: 30, reqPerDay: 1000, tokPerMin: 12000, tokPerDay: 100000 };

export default async function handler(req, res) {
  const now = Date.now();
  const minuteKey = `usage:minute:${Math.floor(now / 60000)}`;
  const dayKey = `usage:day:${Math.floor(now / 86400000)}`;

  const [minReq, minTok, dayReq, dayTok] = await Promise.all([
    redis.get(`${minuteKey}:req`) || 0,
    redis.get(`${minuteKey}:tok`) || 0,
    redis.get(`${dayKey}:req`) || 0,
    redis.get(`${dayKey}:tok`) || 0,
  ]);

  return res.status(200).json({
    minute: { requests: minReq || 0, tokens: minTok || 0 },
    day: { requests: dayReq || 0, tokens: dayTok || 0 },
    limits: LIMITS
  });
}
