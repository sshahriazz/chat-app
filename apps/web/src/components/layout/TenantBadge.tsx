"use client";

import { useEffect, useState } from "react";
import { Badge, Group, Tooltip } from "@mantine/core";
import { getSessionMeta } from "@/lib/auth-client";

/**
 * Compact indicator showing which tenant + scope the current user is
 * signed in under. Reads module-level session metadata (no HTTP), so
 * it's cheap to render wherever we want.
 *
 * Useful in the demo to prove that switching personas actually changes
 * what scope/tenant you're operating under. Hides itself when no session
 * is open (e.g. during sign-out transition).
 */
export function TenantBadge() {
  const [meta, setMeta] = useState(getSessionMeta());

  useEffect(() => {
    // localStorage changes in other tabs bump session meta — re-read so
    // the badge stays in sync if the user signs out elsewhere.
    const onStorage = () => setMeta(getSessionMeta());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (!meta) return null;

  const label = meta.tenantLabel ?? meta.tenantId;
  const scopeLabel = meta.scope ?? "tenant-wide";

  return (
    <Tooltip
      label={
        <>
          Tenant <code>{meta.tenantId}</code> · scope <code>{scopeLabel}</code>
          <br />
          externalId <code>{meta.externalId}</code>
        </>
      }
      withArrow
      multiline
      w={280}
    >
      <Group gap={4} wrap="nowrap" visibleFrom="sm">
        <Badge size="sm" variant="light" color="grape">
          {label}
        </Badge>
        <Badge
          size="sm"
          variant="light"
          color={meta.scope === null ? "gray" : "blue"}
        >
          {scopeLabel}
        </Badge>
      </Group>
    </Tooltip>
  );
}
