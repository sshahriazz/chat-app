"use client";

import { useSyncExternalStore } from "react";
import { Center, Loader } from "@mantine/core";
import { useAuth } from "@/context/AuthContext";
import { AuthForm } from "@/components/auth/AuthForm";
import { AppLayout } from "@/components/layout/AppLayout";

const emptySubscribe = () => () => {};
function useIsMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,  // client
    () => false,  // server
  );
}

export default function Home() {
  const { user, isLoading } = useAuth();
  const mounted = useIsMounted();

  if (!mounted || isLoading) {
    return (
      <Center h="100vh">
        <Loader size="lg" />
      </Center>
    );
  }

  if (!user) {
    return <AuthForm />;
  }

  return <AppLayout />;
}
