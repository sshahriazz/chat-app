"use client";

import { Avatar, Indicator } from "@mantine/core";

interface UserAvatarProps {
  name: string;
  image?: string | null;
  online?: boolean;
  size?: number | string;
}

export function UserAvatar({
  name,
  image,
  online,
  size = "md",
}: UserAvatarProps) {
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const avatar = (
    <Avatar src={image} alt={name} size={size} radius="xl" color="blue">
      {initials}
    </Avatar>
  );

  if (online === undefined) return avatar;

  return (
    <Indicator
      color={online ? "green" : "gray"}
      position="bottom-end"
      size={10}
      offset={4}
      withBorder
    >
      {avatar}
    </Indicator>
  );
}
