"use client";

import { useEffect } from "react";
import { Button, Center, Stack, Text, Title } from "@mantine/core";

/**
 * Per-route error boundary for the App Router. Catches any render-time
 * error thrown by a page or its children (including Rules of Hooks
 * violations, which were otherwise tearing the whole tree down and
 * causing Chrome's "This page couldn't load" page). Keeping the
 * fallback self-contained means the user can hit "Try again" to
 * re-mount without losing the browser tab.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the stack in prod builds too; browsers minify these but
    // the component stack + digest help match against server logs.
    console.error("[route error]", error);
  }, [error]);

  return (
    <Center h="100vh">
      <Stack gap="sm" align="center" maw={420}>
        <Title order={3}>Something went wrong</Title>
        <Text size="sm" c="dimmed" ta="center">
          {error.message || "An unexpected error occurred rendering this page."}
        </Text>
        <Button onClick={reset} variant="light">
          Try again
        </Button>
      </Stack>
    </Center>
  );
}
