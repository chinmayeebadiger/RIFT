import type { Metadata } from "next";
import "./globals.css";
import "./website.css";

export const metadata: Metadata = {
  title: "Rift — Website scanner & recovery",
  description: "Find website issues, understand what broke, and inspect a proposed fix in a clear website audit workspace.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
