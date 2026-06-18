"use client";

import {
  Box,
  Button,
  Center,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconUserOff } from "@tabler/icons-react";

/**
 * Terminal screen reached when the server returns 410 Gone — the
 * server-side GDPR tombstone has rejected this user's token. The
 * tombstone is sticky for 30 days; minting a fresh token for the same
 * externalId would also be rejected, so we don't offer "try again".
 *
 * The API client (`lib/api.ts`) clears the local token and redirects
 * here on any 410; this page is purely informational + an explicit
 * "start over" CTA.
 */
export default function AccountDeletedPage() {
  return (
    <Center mih="100vh">
      <Paper p="xl" radius="md" withBorder style={{ maxWidth: 480 }}>
        <Stack align="center" gap="md">
          <Box c="red.6">
            <IconUserOff size={48} stroke={1.5} />
          </Box>
          <Title order={2} ta="center">
            Account deleted
          </Title>
          <Text c="dimmed" ta="center">
            This account was deleted. Per our retention policy the
            <code style={{ margin: "0 4px" }}>(tenantId, externalId)</code>
            pair is held in a tombstone for 30 days, so sessions for the
            same account are rejected during that window.
          </Text>
          <Text c="dimmed" ta="center" size="sm">
            If this was a mistake, contact your administrator. To use the
            app with a different account, sign in below.
          </Text>
          <Button
            variant="filled"
            onClick={() => {
              if (typeof window !== "undefined") window.location.replace("/");
            }}
          >
            Start over
          </Button>
        </Stack>
      </Paper>
    </Center>
  );
}
