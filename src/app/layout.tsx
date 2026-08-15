import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Sympose MVP · Event operating system",
    template: "%s · Sympose",
  },
  description:
    "Sympose is an event operating system for composing explainable plans, commitments, and live operations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" data-theme-preference="system" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var k="sympose-theme",v=localStorage.getItem(k),p=v==="light"||v==="dark"||v==="system"?v:"system",d=p==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":p==="system"?"light":p,r=document.documentElement;r.setAttribute("data-theme",d);r.setAttribute("data-theme-preference",p);r.style.colorScheme=d}catch(_){}})()`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
