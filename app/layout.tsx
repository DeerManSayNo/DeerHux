import type { Metadata } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import { DisableNativeContextMenu } from "@/components/DisableNativeContextMenu";
import { DisableTabNavigation } from "@/components/DisableTabNavigation";
import "./globals.css";
import "./design-tokens.css";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "DeerHux",
  description: "DeerHux网页界面",
};

const themeBootstrapScript = `
try {
  const stored = localStorage.getItem("deerhux-theme") || localStorage.getItem("pi-theme");
  const theme = stored === "light" || stored === "dark"
    ? stored
    : window.__DEERHUX_STARTUP_THEME === "light" ? "light" : "dark";
  document.documentElement.classList.toggle("dark", theme === "dark");
} catch {
  document.documentElement.classList.toggle("dark", window.__DEERHUX_STARTUP_THEME !== "light");
}
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className={`${notoSansMono.variable} dark`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
        <DisableNativeContextMenu />
        <DisableTabNavigation />
        {children}
      </body>
    </html>
  );
}
