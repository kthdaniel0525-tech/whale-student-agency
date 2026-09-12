import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingExcludes: { "/*": ["./.local/**/*", "./.env*"] },
  serverExternalPackages: [
    "@huggingface/transformers",
    "onnxruntime-node",
    "pdfjs-dist",
  ],
};

export default nextConfig;
