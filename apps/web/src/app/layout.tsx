import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./globals.css";

import type { Metadata } from "next";
import {
  MantineProvider,
  mantineHtmlProps,
  createTheme,
} from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { AuthProvider } from "@/context/AuthContext";

const theme = createTheme({
  primaryColor: "blue",
  defaultRadius: "md",
});

export const metadata: Metadata = {
  title: "Chat App",
  description: "Real-time chat application",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head />
      <body>
        <MantineProvider theme={theme} defaultColorScheme="auto">
          <Notifications position="top-right" />
          <AuthProvider>{children}</AuthProvider>
        </MantineProvider>
      </body>
    </html>
  );
}
