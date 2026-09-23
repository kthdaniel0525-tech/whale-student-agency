import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/features/student/components/providers";
export const metadata: Metadata = {
  title: { default: "Student Agency", template: "%s · Student Agency" },
  description:
    "Your semester, in one place. Courses, deadlines and academic priorities.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
