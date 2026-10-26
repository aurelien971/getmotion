import type { Metadata, Viewport } from "next";
import { Onest, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

const onest = Onest({
  variable: "--font-onest",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Display face for the landing page (Onest stays the text face everywhere).
const schibsted = Schibsted_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://getmotion.art"),
  title: "getmotion · put someone new in any video",
  description: "Paste a video, add photos of who goes in, and get the same scene back with them in it. Same moves, same camera, same light, the original sound.",
  openGraph: { images: ["/brand/og.jpg"] },
};

export const viewport: Viewport = {
  themeColor: "#000000",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${onest.variable} ${schibsted.variable}`}>
      <body>{children}</body>
    </html>
  );
}
