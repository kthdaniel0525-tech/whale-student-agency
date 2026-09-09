import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CodeChoiceAI · 코드 리뷰",
  description: "코드 가독성, 유지보수성, 시간 복잡도와 개선 방향을 분석하세요.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
