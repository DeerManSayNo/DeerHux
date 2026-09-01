import type { Metadata } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const themeInitScript = `
try {
  var theme = localStorage.getItem("deerhux-theme") || localStorage.getItem("pi-theme");
  document.documentElement.classList.toggle("dark", theme === "dark");
} catch (_) {}
`;

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "DeerHux",
  description: "DeerHux网页界面",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className={notoSansMono.variable} suppressHydrationWarning>
      <head>
        <Script
          id="deerhux-theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
      </head>
      <body style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
        {children}
      </body>
    </html>
  );
}
