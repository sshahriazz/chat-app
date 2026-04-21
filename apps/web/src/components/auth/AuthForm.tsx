"use client";

import { useState } from "react";
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
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useAuth } from "@/context/AuthContext";

export function AuthForm() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loading, setLoading] = useState(false);

  const form = useForm({
    mode: "uncontrolled",
    initialValues: {
      name: "",
      email: "",
      password: "",
    },
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
    <Center h="100vh">
      <Box w={420}>
        <Title ta="center" mb={4}>
          Chat App
        </Title>
        <Text c="dimmed" size="sm" ta="center" mb={20}>
          {mode === "login"
            ? "Sign in to your account"
            : "Create a new account"}
        </Text>

        <Paper withBorder shadow="md" p={30} radius="md">
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
        </Paper>
      </Box>
    </Center>
  );
}
