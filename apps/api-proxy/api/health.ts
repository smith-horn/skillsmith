import type { VercelRequest, VercelResponse } from '@vercel/node'

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'skillsmith-api-proxy',
    version: '1.0.0',
    upstream: 'https://vrcnzpmndtroqxxoqkzy.supabase.co',
  })
}
