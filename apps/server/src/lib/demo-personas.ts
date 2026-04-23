/**
 * Hard-coded demo personas used by the reference web client's
 * persona-picker sign-in. The server exposes them over
 * `GET /api/dev/personas` and auto-creates the backing Tenant rows
 * on `POST /api/dev/seed-demo` so a fresh DB boot demos end-to-end
 * without any operator / admin-API steps.
 *
 * This is DEV-ONLY. The routes mount only when `DEV_MINT_ENABLED=true`
 * (or NODE_ENV !== "production"). No production deploy ever runs this.
 */

export interface DemoPersona {
  externalId: string;
  name: string;
  image: string | null;
  /** Non-null ⇒ scoped to this partition; null ⇒ tenant-wide. */
  scope: string | null;
  /** Short sentence shown in the UI so the user knows what to expect. */
  description: string;
}

export interface DemoTenant {
  tenantId: string;
  tenantLabel: string;
  tenantDescription: string;
  scopes: Array<{ id: string; label: string }>;
  users: DemoPersona[];
}

export const DEMO_TENANTS: DemoTenant[] = [
  {
    tenantId: "demo_acme",
    tenantLabel: "Acme CRM",
    tenantDescription:
      "Project-based chat. Project members only see other members of their project + tenant-wide admins.",
    scopes: [
      { id: "project_alpha", label: "Project Alpha" },
      { id: "project_beta", label: "Project Beta" },
    ],
    users: [
      {
        externalId: "alice@acme",
        name: "Alice Chen",
        image: null,
        scope: "project_alpha",
        description: "Project Alpha member — will only see Alpha peers + admins",
      },
      {
        externalId: "bob@acme",
        name: "Bob Park",
        image: null,
        scope: "project_alpha",
        description: "Project Alpha member",
      },
      {
        externalId: "carlos@acme",
        name: "Carlos Ruiz",
        image: null,
        scope: "project_beta",
        description: "Project Beta member — cannot see Alpha users",
      },
      {
        externalId: "dana@acme",
        name: "Dana Ng",
        image: null,
        scope: "project_beta",
        description: "Project Beta member",
      },
      {
        externalId: "eli@acme",
        name: "Eli Osei",
        image: null,
        scope: null,
        description: "Admin — tenant-wide, sees every user in Acme",
      },
    ],
  },
  {
    tenantId: "demo_beta",
    tenantLabel: "BetaCorp Support",
    tenantDescription:
      "Support tickets. Customers are scoped to their ticket; agents are tenant-wide and bridge across tickets.",
    scopes: [{ id: "ticket_4711", label: "Ticket #4711" }],
    users: [
      {
        externalId: "freya@customer",
        name: "Freya Jensen",
        image: null,
        scope: "ticket_4711",
        description: "Customer on ticket #4711 — can only see agents + own ticket peers",
      },
      {
        externalId: "greta@beta",
        name: "Greta Larsen",
        image: null,
        scope: null,
        description: "Support agent — tenant-wide, can reach every BetaCorp customer",
      },
    ],
  },
];

export function findPersona(
  tenantId: string,
  externalId: string,
): DemoPersona | null {
  const tenant = DEMO_TENANTS.find((t) => t.tenantId === tenantId);
  if (!tenant) return null;
  return tenant.users.find((u) => u.externalId === externalId) ?? null;
}
