import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { Spinner } from "@/components/ui";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "DCT Finance",
  description: "Contract rulebooks for Discovery Clinical Trials",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <Providers>
          {/* Everything below reads URL params / browser state, so it renders at request time. */}
          <Suspense fallback={<div className="h-14 border-b border-line bg-surface" />}>
            <AppHeader />
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
        </Providers>
      </body>
    </html>
  );
}
