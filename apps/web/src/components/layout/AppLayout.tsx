"use client";

import {
  AppShell,
  Group,
  Text,
  ActionIcon,
  Menu,
  Burger,
  Avatar,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconLogout,
  IconMoon,
  IconSun,
  IconSettings,
  IconSearch,
} from "@tabler/icons-react";
import Link from "next/link";
import { useMantineColorScheme, useComputedColorScheme } from "@mantine/core";
import { spotlight } from "@mantine/spotlight";
import { useAuth } from "@/context/AuthContext";
import { ChatProvider, useChat } from "@/context/ChatContext";
import { ConversationList } from "@/components/sidebar/ConversationList";
import { ChatView } from "@/components/chat/ChatView";
import { GlobalSearchSpotlight } from "@/components/search/GlobalSearchSpotlight";

function AppContent() {
  const { user, signOut } = useAuth();
  const { setActiveConversation, activeConversationId } = useChat();
  const { setColorScheme } = useMantineColorScheme();
  const computedColorScheme = useComputedColorScheme("light");
  const [navbarOpen, { toggle: toggleNavbar, close: closeNavbar }] =
    useDisclosure(true);

  const handleSelectConversation = (id: string) => {
    setActiveConversation(id);
    closeNavbar(); // Close navbar on mobile after selecting
  };

  return (
    <AppShell
      navbar={{
        width: 350,
        breakpoint: "sm",
        collapsed: { mobile: !navbarOpen },
      }}
      header={{ height: 50 }}
      padding={0}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger
              opened={navbarOpen}
              onClick={toggleNavbar}
              hiddenFrom="sm"
              size="sm"
            />
            <Text fw={700} size="lg">
              Chat App
            </Text>
          </Group>
          <Group gap="xs">
            <ActionIcon
              variant="subtle"
              size="lg"
              onClick={() => spotlight.open()}
              title="Search all messages (⌘K)"
              aria-label="Search all messages"
            >
              <IconSearch size={18} />
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              size="lg"
              onClick={() =>
                setColorScheme(
                  computedColorScheme === "dark" ? "light" : "dark",
                )
              }
            >
              {computedColorScheme === "dark" ? (
                <IconSun size={18} />
              ) : (
                <IconMoon size={18} />
              )}
            </ActionIcon>
            <Menu shadow="md">
              <Menu.Target>
                <UnstyledButton aria-label="Account menu">
                  <Avatar
                    src={user?.image}
                    name={user?.name}
                    size={32}
                    radius={32}
                    imageProps={{ loading: "lazy", decoding: "async" }}
                  />
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{user?.name}</Menu.Label>
                <Menu.Label>{user?.email}</Menu.Label>
                <Menu.Divider />
                <Menu.Item
                  component={Link}
                  href="/settings"
                  leftSection={<IconSettings size={14} />}
                >
                  Settings
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconLogout size={14} />}
                  onClick={signOut}
                  color="red"
                >
                  Sign out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar>
        <ConversationList onSelect={handleSelectConversation} />
      </AppShell.Navbar>

      <AppShell.Main
        style={{ height: "calc(100vh - 50px)", display: "flex" }}
      >
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <ChatView />
        </div>
      </AppShell.Main>
      <GlobalSearchSpotlight />
    </AppShell>
  );
}

export function AppLayout() {
  return (
    <ChatProvider>
      <AppContent />
    </ChatProvider>
  );
}
