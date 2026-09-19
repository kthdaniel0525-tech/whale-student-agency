import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OAuth callback query strings contain one-time credentials. Never log them.
  logging: { incomingRequests: { ignore: [/\/api\/student\/integrations\/[^/]+\/callback/] } },
  outputFileTracingExcludes: { "/*": ["./.local/**/*", "./.env*"] },
  serverExternalPackages: [
    "@huggingface/transformers",
    "onnxruntime-node",
    "pdfjs-dist",
  ],
};

export default nextConfig;
