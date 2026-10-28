import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Suspense } from "react";
import { Sidebar, TopBar } from "@/components/AppHeader";
import { Spinner } from "@/components/ui";
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
          <div className="min-h-screen lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
            <Suspense fallback={<aside className="border-r border-line bg-surface" />}>
              <Sidebar />
            </Suspense>
            <div className="flex min-w-0 flex-col">
              <Suspense fallback={<div className="h-14 border-b border-line" />}>
                <TopBar />
              </Suspense>
              <main className="flex flex-1 flex-col">
                <Suspense
                  fallback={
                    <div className="p-8">
                      <Spinner />
                    </div>
                  }
                >
                  {children}
                </Suspense>
              </main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
