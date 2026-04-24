/** @type {import('next').NextConfig} */
const nextConfig = {
  // ESLint roda via `npm run lint` manualmente (ou CI).
  // Não bloqueia build de prod — muitas das flags são estilo
  // (@typescript-eslint/no-explicit-any, no-unused-vars) que podem
  // ser limpas num pass dedicado sem afetar deploy.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
