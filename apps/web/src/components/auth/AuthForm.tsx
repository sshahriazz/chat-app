"use client";

import { useEffect, useState } from "react";
import {
  Paper,
  TextInput,
  PasswordInput,
  Button,
  Title,
  Text,
  Anchor,
  Stack,
  Center,
  Box,
  Tabs,
  Badge,
  Group,
  Avatar,
  Divider,
  Loader,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { IconUsers, IconMail } from "@tabler/icons-react";
import { useAuth } from "@/context/AuthContext";

interface DemoPersona {
  externalId: string;
  name: string;
  image: string | null;
  scope: string | null;
  description: string;
}

interface DemoTenant {
  tenantId: string;
  tenantLabel: string;
  tenantDescription: string;
  scopes: Array<{ id: string; label: string }>;
  users: DemoPersona[];
}

/** Email/password form — lands in the `default` tenant, no scope. */
function EmailPasswordForm() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loading, setLoading] = useState(false);

  const form = useForm({
    mode: "uncontrolled",
    initialValues: { name: "", email: "", password: "" },
    validate: {
      name: (value) =>
        mode === "register" && value.trim().length < 2
          ? "Name must be at least 2 characters"
          : null,
      email: (value) =>
        /^\S+@\S+\.\S+$/.test(value) ? null : "Invalid email",
      password: (value) =>
        value.length < 8 ? "Password must be at least 8 characters" : null,
    },
  });

  const handleSubmit = async (values: typeof form.values) => {
    setLoading(true);
    try {
      if (mode === "register") {
        await signUp(values.name, values.email, values.password);
      } else {
        await signIn(values.email, values.password);
      }
    } catch (err) {
      notifications.show({
        title: "Error",
        message: err instanceof Error ? err.message : "Something went wrong",
        color: "red",
      });
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setMode((m) => (m === "login" ? "register" : "login"));
    form.reset();
  };

  return (
    <>
      <Text c="dimmed" size="xs" mb="md">
        Signs in under the <code>default</code> tenant. No scope — these
        users are fully tenant-wide and see every other default-tenant user.
      </Text>
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          {mode === "register" && (
            <TextInput
              label="Name"
              placeholder="Your name"
              required
              key={form.key("name")}
              {...form.getInputProps("name")}
            />
          )}
          <TextInput
            label="Email"
            placeholder="you@example.com"
            required
            type="email"
            key={form.key("email")}
            {...form.getInputProps("email")}
          />
          <PasswordInput
            label="Password"
            placeholder="Your password"
            required
            key={form.key("password")}
            {...form.getInputProps("password")}
          />
          <Button type="submit" fullWidth loading={loading}>
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </Stack>
      </form>
      <Text c="dimmed" size="sm" ta="center" mt="md">
        {mode === "login" ? (
          <>
            Don&apos;t have an account?{" "}
            <Anchor component="button" size="sm" onClick={toggleMode}>
              Register
            </Anchor>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Anchor component="button" size="sm" onClick={toggleMode}>
              Sign in
            </Anchor>
          </>
        )}
      </Text>
    </>
  );
}

/** One persona card — click to sign in. */
function PersonaCard({
  persona,
  tenantId,
  tenantLabel,
  onPick,
  disabled,
}: {
  persona: DemoPersona;
  tenantId: string;
  tenantLabel: string;
  onPick: (p: {
    tenantId: string;
    tenantLabel: string;
    externalId: string;
    name: string;
    scope: string | null;
  }) => void;
  disabled: boolean;
}) {
  return (
    <Paper
      withBorder
      p="sm"
      radius="md"
      style={{ cursor: disabled ? "wait" : "pointer" }}
      onClick={() =>
        !disabled &&
        onPick({
          tenantId,
          tenantLabel,
          externalId: persona.externalId,
          name: persona.name,
          scope: persona.scope,
        })
      }
    >
      <Group wrap="nowrap" align="flex-start">
        <Avatar color="initials" name={persona.name} radius="xl" />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <Text fw={600} size="sm" truncate>
              {persona.name}
            </Text>
            {persona.scope === null ? (
              <Badge size="xs" color="grape" variant="light">
                tenant-wide
              </Badge>
            ) : (
              <Badge size="xs" color="blue" variant="light">
                {persona.scope}
              </Badge>
            )}
          </Group>
          <Text c="dimmed" size="xs" lineClamp={2}>
            {persona.description}
          </Text>
        </Box>
      </Group>
    </Paper>
  );
}

function PersonaPicker() {
  const { signInAsPersona } = useAuth();
  const [tenants, setTenants] = useState<DemoTenant[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Kick off the demo seed in parallel with fetching the persona
    // list. Both are idempotent and complete in well under a second.
    void fetch("/api/dev/seed-demo", { method: "POST" }).catch(() => {});
    fetch("/api/dev/personas")
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error("load failed")),
      )
      .then((data: { tenants: DemoTenant[] }) => {
        if (!cancelled) setTenants(data.tenants);
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pick = async (p: {
    tenantId: string;
    tenantLabel: string;
    externalId: string;
    name: string;
    scope: string | null;
  }) => {
    setLoggingIn(p.externalId);
    try {
      await signInAsPersona(p);
    } catch (err) {
      notifications.show({
        title: "Sign in failed",
        message: err instanceof Error ? err.message : "Unknown error",
        color: "red",
      });
      setLoggingIn(null);
    }
  };

  if (loadError) {
    return (
      <Stack align="center" py="md">
        <Text size="sm" c="red">
          Could not load demo personas: {loadError}
        </Text>
        <Text size="xs" c="dimmed" ta="center">
          Persona sign-in requires <code>DEV_MINT_ENABLED=true</code> on the
          server. Use the Email tab instead.
        </Text>
      </Stack>
    );
  }

  if (!tenants) {
    return (
      <Center py="xl">
        <Loader size="sm" />
      </Center>
    );
  }

  return (
    <Stack gap="md">
      <Text c="dimmed" size="xs">
        Pick any user to sign in. Each tenant is fully isolated from the
        others; inside a tenant, scoped users only see same-scope +
        tenant-wide peers.
      </Text>

      {tenants.map((t, i) => (
        <Box key={t.tenantId}>
          {i > 0 && <Divider my="md" />}
          <Group gap={6} mb={4}>
            <Text fw={700} size="sm">
              {t.tenantLabel}
            </Text>
            <Badge size="xs" variant="outline">
              {t.tenantId}
            </Badge>
          </Group>
          <Text c="dimmed" size="xs" mb="xs">
            {t.tenantDescription}
          </Text>
          <Stack gap={6}>
            {t.users.map((u) => (
              <PersonaCard
                key={`${t.tenantId}:${u.externalId}`}
                persona={u}
                tenantId={t.tenantId}
                tenantLabel={t.tenantLabel}
                onPick={pick}
                disabled={loggingIn === u.externalId}
              />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

export function AuthForm() {
  return (
    <Center mih="100vh" py="xl">
      <Box w={520} maw="100%">
        <Title ta="center" mb={4}>
          Chat App
        </Title>
        <Text c="dimmed" size="sm" ta="center" mb={20}>
          Multi-tenant demo. Pick a persona to see tenant + scope isolation in
          action, or use email/password under the default tenant.
        </Text>

        <Paper withBorder shadow="md" p={24} radius="md">
          <Tabs defaultValue="personas" keepMounted={false}>
            <Tabs.List mb="md" grow>
              <Tabs.Tab
                value="personas"
                leftSection={<IconUsers size={14} />}
              >
                Demo personas
              </Tabs.Tab>
              <Tabs.Tab value="email" leftSection={<IconMail size={14} />}>
                Email
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="personas">
              <PersonaPicker />
            </Tabs.Panel>

            <Tabs.Panel value="email">
              <EmailPasswordForm />
            </Tabs.Panel>
          </Tabs>
        </Paper>
      </Box>
    </Center>
  );
}
