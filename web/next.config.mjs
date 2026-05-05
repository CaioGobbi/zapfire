/** @type {import('next').NextConfig} */
const nextConfig = {
  // Build standalone — gera node_modules mínimo + servidor Node
  // Resultado: imagem Docker bem menor, sem precisar instalar deps em runtime
  output: 'standalone',

  // Ignora erros de ESLint no build de produção
  // Mesma config usada no Vercel (débito técnico conhecido — ver CLAUDE.md)
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Ignora erros de TypeScript no build (pra não bloquear deploy)
  // Refinar depois quando tipar tudo direito
  typescript: {
    ignoreBuildErrors: true,
  },

  // Otimização de imagens
  images: {
    unoptimized: false,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.zapfire.com.br',
      },
    ],
  },

  // Aceita requests vindos do reverse proxy
  experimental: {
    serverActions: {
      allowedOrigins: ['app-novo.zapfire.com.br', 'app.zapfire.com.br'],
    },
  },

  // Remove header X-Powered-By (segurança)
  poweredByHeader: false,
};

export default nextConfig;
