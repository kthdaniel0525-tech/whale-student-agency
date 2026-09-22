import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  async headers() {
    // Next's hydration/theme bootstrap currently requires inline scripts; do
    // not add unsafe-eval in production. A nonce policy requires dynamic SSR.
    const production = process.env.NODE_ENV === "production";
    const policy = ["default-src 'self'", `script-src 'self' 'unsafe-inline'${production ? "" : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
      `connect-src 'self'${production ? "" : " ws://localhost:* ws://127.0.0.1:*"}`,
      "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join("; ");
    return [{ source: "/:path*", headers: [
      { key: "Content-Security-Policy", value: policy },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      ...(production ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
    ] }];
  },
  // OAuth callback query strings contain one-time credentials. Never log them.
  logging: { incomingRequests: { ignore: [/\/api\/student\/integrations\/[^/]+\/callback/, /\/api\/auth(?:\/|$)/, /\/billing\/(?:success|cancelled)/] } },
  outputFileTracingExcludes: { "/*": ["./.local/**/*", "./.env*"] },
  // The isolated PDF worker resolves these at runtime, outside the bundler.
  // Include both PDF.js modules and its native DOMMatrix/canvas dependency.
  outputFileTracingIncludes: { "/*": [
    "./node_modules/pdfjs-dist/legacy/build/*.mjs",
    "./node_modules/pdfjs-dist/package.json",
    "./node_modules/@napi-rs/canvas*/**/*",
  ] },
  serverExternalPackages: [
    "@huggingface/transformers",
    "onnxruntime-node",
    "pdfjs-dist",
  ],
};

export default nextConfig;
