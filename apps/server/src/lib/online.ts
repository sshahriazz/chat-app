// In-memory online user tracker.
// In production, use Redis for multi-instance support.

const onlineUsers = new Map<string, number>(); // userId -> connection count

export function userConnected(userId: string) {
  onlineUsers.set(userId, (onlineUsers.get(userId) || 0) + 1);
}

export function userDisconnected(userId: string) {
  const count = (onlineUsers.get(userId) || 1) - 1;
  if (count <= 0) {
    onlineUsers.delete(userId);
  } else {
    onlineUsers.set(userId, count);
  }
}

export function isOnline(userId: string): boolean {
  return onlineUsers.has(userId);
}

export function getOnlineUserIds(): string[] {
  return Array.from(onlineUsers.keys());
}

export function filterOnline(userIds: string[]): string[] {
  return userIds.filter((id) => onlineUsers.has(id));
}
