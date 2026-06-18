"use client";

import { useEffect, useRef, useState } from "react";
import {
  Container,
  Stack,
  Title,
  TextInput,
  Button,
  Group,
  Text,
  Paper,
  Avatar,
  ActionIcon,
  Loader,
  Modal,
  Divider,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconArrowLeft,
  IconCamera,
  IconLogout2,
  IconTrash,
} from "@tabler/icons-react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { authClient } from "@/lib/auth-client";
import { uploadFile } from "@/lib/upload";
import { api } from "@/lib/api";

export default function SettingsPage() {
  const { user, isLoading, signOut } = useAuth();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [revokeOpen, { open: openRevoke, close: closeRevoke }] =
    useDisclosure(false);
  const [revoking, setRevoking] = useState(false);

  const handleRevoke = async () => {
    setRevoking(true);
    try {
      // "Log out everywhere": bumps User.tokensValidAfter on the
      // server, invalidating every JWT issued before now — including
      // the one this tab is holding. Clear our local token + sign out
      // proactively rather than waiting for the next 401.
      await api.post("/api/users/me/revoke");
      notifications.show({
        title: "Signed out everywhere",
        message: "Every existing session for this account has been revoked.",
        color: "green",
      });
      await signOut();
    } catch (err) {
      notifications.show({
        title: "Sign-out failed",
        message: (err as Error).message,
        color: "red",
      });
    } finally {
      setRevoking(false);
      closeRevoke();
    }
  };
  // Local blob preview of a freshly-picked avatar. The storage bucket
  // is private, so the uploaded `image` URL won't render directly — we
  // show this blob for immediate feedback. NOTE: avatars are a demo
  // convenience; in production the avatar comes from the tenant JWT
  // `image` claim (an externally-hosted URL). See BREAKING_CHANGES.md.
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name);
      setImage(user.image);
    }
  }, [user]);

  if (isLoading) {
    return (
      <Container py="xl">
        <Loader />
      </Container>
    );
  }

  if (!user) {
    return (
      <Container py="xl">
        <Text>You must be signed in to access settings.</Text>
      </Container>
    );
  }

  const dirty = name !== user.name || image !== user.image;

  const handlePickAvatar = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      notifications.show({
        title: "Invalid file",
        message: "Please pick an image.",
        color: "red",
      });
      return;
    }
    setUploading(true);
    // Revoke any prior preview blob before creating a new one.
    setPreviewSrc((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    try {
      // Avatars upload to `avatars/<userId>/...` and live in the public
      // bucket prefix (granted anonymous GET in `minio-init`), so the
      // returned `att.url` renders cross-user without any per-render
      // signed-URL fetch.
      const att = await uploadFile(file, { purpose: "avatar" });
      setImage(att.url);
    } catch (err) {
      notifications.show({
        title: "Upload failed",
        message: (err as Error).message,
        color: "red",
      });
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      // authClient.updateUser re-mints the JWT with new claims. The
      // server upserts the User row on the next authenticated request;
      // the page reload below refreshes every useSession subscriber
      // (AuthContext, ConversationItem avatars, ChatHeader).
      const result = await authClient.updateUser({
        name,
        image: image ?? "",
      });
      if (result.error) throw new Error(result.error.message);
      // Tell peers so their cached avatars refresh live. Best-effort;
      // failure here doesn't undo the save itself.
      api.post("/api/me/broadcast-profile").catch(() => {});
      notifications.show({
        title: "Saved",
        message: "Profile updated.",
        color: "green",
      });
    } catch (err) {
      notifications.show({
        title: "Save failed",
        message: (err as Error).message,
        color: "red",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Container size="sm" py="xl">
      <Group mb="lg">
        <ActionIcon
          component={Link}
          href="/"
          variant="subtle"
          size="lg"
          aria-label="Back"
        >
          <IconArrowLeft size={18} />
        </ActionIcon>
        <Title order={2}>Settings</Title>
      </Group>

      <Paper withBorder p="lg" radius="md">
        <Stack>
          <Group align="center">
            <div style={{ position: "relative" }}>
              <Avatar
                src={previewSrc ?? image}
                name={name}
                size={96}
                radius={96}
                imageProps={{ loading: "lazy", decoding: "async" }}
              />
              {uploading && (
                <Loader
                  size="sm"
                  style={{
                    position: "absolute",
                    inset: 0,
                    margin: "auto",
                  }}
                />
              )}
            </div>
            <Stack gap={4}>
              <Button
                variant="light"
                size="xs"
                leftSection={<IconCamera size={14} />}
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                Change photo
              </Button>
              {image && (
                <Button
                  variant="subtle"
                  color="red"
                  size="xs"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => {
                    setPreviewSrc((prev) => {
                      if (prev) URL.revokeObjectURL(prev);
                      return null;
                    });
                    setImage(null);
                  }}
                  disabled={uploading}
                >
                  Remove photo
                </Button>
              )}
            </Stack>
          </Group>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              void handlePickAvatar(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />

          <TextInput
            label="Display name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />

          <TextInput label="Email" value={user.email} disabled />

          <Group justify="flex-end" mt="sm">
            <Button
              variant="subtle"
              onClick={() => {
                setName(user.name);
                setPreviewSrc((prev) => {
                  if (prev) URL.revokeObjectURL(prev);
                  return null;
                });
                setImage(user.image);
              }}
              disabled={!dirty || saving}
            >
              Reset
            </Button>
            <Button
              onClick={handleSave}
              loading={saving}
              disabled={!dirty || uploading || !name.trim()}
            >
              Save changes
            </Button>
          </Group>

          <Divider my="md" label="Account security" labelPosition="left" />

          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Stack gap={2}>
              <Text fw={500}>Sign out of every session</Text>
              <Text size="xs" c="dimmed">
                Revokes every existing token for this account on every
                device. New sessions are unaffected; you&apos;ll need to
                sign in again here.
              </Text>
            </Stack>
            <Button
              variant="outline"
              color="red"
              leftSection={<IconLogout2 size={14} />}
              onClick={openRevoke}
            >
              Sign out everywhere
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Modal
        opened={revokeOpen}
        onClose={closeRevoke}
        title="Sign out of every session?"
        centered
      >
        <Stack>
          <Text size="sm">
            This will revoke every existing access token for your account.
            You&apos;ll be signed out of this tab and any other open session.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={closeRevoke} disabled={revoking}>
              Cancel
            </Button>
            <Button color="red" loading={revoking} onClick={handleRevoke}>
              Sign out everywhere
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Container>
  );
}
