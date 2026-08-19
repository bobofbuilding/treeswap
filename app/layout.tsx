import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const siteUrl = "https://treeswap.vercel.app";
const title = "TreeSwap | Bitcoin Lightning ↔ BIT Swaps";
const description =
  "Compare signed solver quotes to swap Bitcoin Lightning sats and Bittrees BIT. Explore TreeSwap's safety-first, non-custodial prototype.";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  applicationName: "TreeSwap",
  category: "finance",
  creator: "TreeSwap",
  publisher: "TreeSwap",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/",
    siteName: "TreeSwap",
    title,
    description,
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "TreeSwap — Swap Lightning sats and BIT",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "TreeSwap",
  url: siteUrl,
  description,
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  isAccessibleForFree: true,
  license: "https://opensource.org/license/mit",
  codeRepository: "https://github.com/bobofbuilding/treeswap",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structuredData).replaceAll("<", "\\u003c"),
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
