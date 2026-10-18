import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // The dev-only badge floats over the phone tab bar and blocks taps while developing. It does not exist in production.
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  // The project page (a static file in public/about) is the front page. /about stays as an alias.
  async rewrites() {
    return { beforeFiles: [{ source: "/", destination: "/about/index.html" }], afterFiles: [], fallback: [] };
  },
  async redirects() {
    return [{ source: "/about", destination: "/", permanent: false }];
  },
};

export default nextConfig;
