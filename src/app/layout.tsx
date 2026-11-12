import type { Metadata, Viewport } from "next";
import { Geist_Mono, Instrument_Sans } from "next/font/google";
import "./globals.css";

// Fonts are downloaded at build time and served by the app itself (#175):
// Instrument Sans, with its width axis for the condensed display type, is the
// interface; Geist Mono is kept for commands and codes.
const instrument = Instrument_Sans({
  variable: "--font-instrument",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CreatorBrio - AI Creative Studio",
  description:
    "A local-first, AI-assisted creative studio for branded social content. Design Instagram carousels, LinkedIn documents and Reel covers by chatting with Claude.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f1f2f4",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      translate="no"
      className={`${instrument.variable} ${geistMono.variable} antialiased`}
      suppressHydrationWarning
    >
      <head>
        <meta name="google" content="notranslate" />
      </head>
      <body className="notranslate" suppressHydrationWarning>{children}</body>
    </html>
  );
}
