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
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowLeft, IconCamera, IconTrash } from "@tabler/icons-react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { authClient } from "@/lib/auth-client";
import { uploadFile } from "@/lib/upload";
import { api } from "@/lib/api";

export default function SettingsPage() {
  const { user, isLoading } = useAuth();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState<string | null>(null);
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
    try {
      const att = await uploadFile(file);
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
      // better-auth persists name/image on the User row and refreshes the
      // session automatically — `useSession` subscribers (AuthContext,
      // ConversationItem avatars, ChatHeader) re-render with the new data.
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
              <Avatar src={image} name={name} size={96} radius={96} />
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
                  onClick={() => setImage(null)}
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
        </Stack>
      </Paper>
    </Container>
  );
}
