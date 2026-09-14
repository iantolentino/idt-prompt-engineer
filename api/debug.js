export default async function handler(req, res) {
  return res.status(200).json({
    env_groq_set: !!process.env.GROQ_API_KEY,
    env_redis_set: !!process.env.REDIS_URL,
    model_set: 'mixtral-8x7b-32768',
    timestamp: new Date().toISOString()
  });
}
