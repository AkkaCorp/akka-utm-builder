import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "@akka/auth/auth.css";
import "./globals.css";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-poppins",
  display: "swap",
});

export const metadata: Metadata = {
  title: "UTM Link Builder — Akka",
  description: "Build correctly formatted UTM tracking links for akka.app, and short links on go.akka.app.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={poppins.variable}>
      <body>{children}</body>
    </html>
  );
}
