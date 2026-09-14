export default async function handler(req, res) {
  try {
    return res.status(200).json({ ok: true, env_groq: !!process.env.GROQ_API_KEY, env_redis: !!process.env.REDIS_URL, model: 'test' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
