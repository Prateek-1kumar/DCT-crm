import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Suspense } from "react";
import { AppFrame } from "@/components/AppFrame";
import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "DCT Finance",
  description: "Invoicing masters from signed sponsor contracts, for Discovery Clinical Trials",
  icons: { icon: "/dct-mark.png" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full">
        <Providers>
          {/* Everything below reads URL params / browser state, so it renders at request time. */}
          <Suspense>
            <AppFrame>{children}</AppFrame>
          </Suspense>
        </Providers>
      </body>
    </html>
  );
}
