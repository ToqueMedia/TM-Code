import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  allowedDevOrigins: ['http://localhost:1420', 'tauri://localhost'],
}

export default nextConfig
