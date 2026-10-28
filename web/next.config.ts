import { loadEnvConfig } from '@next/env';
import path from 'node:path';
import type { NextConfig } from 'next';

loadEnvConfig(path.resolve('..'));
const config:NextConfig={poweredByHeader:false,devIndicators:false,turbopack:{root:path.resolve('.')},
  async headers() {return [{source:'/:path*',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'X-Frame-Options',value:'DENY'},{key:'Referrer-Policy',value:'no-referrer'}]}];},
};
export default config;
