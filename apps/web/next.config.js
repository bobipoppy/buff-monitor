/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@buff-monitor/shared'],
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: '**.fp.ps.netease.com' },
      { protocol: 'https', hostname: 'buff.163.com' },
    ],
  },
};

module.exports = nextConfig;
