/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@buff-monitor/shared'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.fp.ps.netease.com' },
      { protocol: 'https', hostname: 'buff.163.com' },
    ],
  },
};

module.exports = nextConfig;
