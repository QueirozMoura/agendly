import { describe, expect, it } from "vitest";
import { can } from "../../src/modules/auth/permissions.ts";

// Ações concretas cobertas pelos padrões da matriz do MVP (3.2).
const OWNER_ACTIONS = [
  "account.sessions.list",
  "account.logout_all",
  "org.view",
  "org.settings.update",
  "org.public_page.publish",
  "org.public_page.unpublish",
  "services.create",
  "services.update",
  "services.toggle",
  "professionals.create",
  "professionals.link_service",
  "availability.read",
  "availability.write",
  "availability.working_hours.update",
  "availability.time_off.create",
  "customers.read",
  "customers.write",
  "customers.privacy",
  "appointments.read",
  "appointments.create",
  "appointments.reschedule",
  "appointments.cancel",
  "appointments.confirm",
  "appointments.set_status",
  "session.switch_org",
];

describe("can(role, action) — matriz do MVP (somente OWNER)", () => {
  it("todas as ações da matriz são permitidas ao OWNER", () => {
    for (const action of OWNER_ACTIONS)
      expect(can("OWNER", action), action).toBe(true);
  });

  it("default deny: papel desconhecido, ausente ou malicioso nega TUDO", () => {
    for (const role of [
      "ADMIN",
      "STAFF",
      "owner",
      "",
      "constructor",
      "__proto__",
      "toString",
      undefined,
      null,
    ]) {
      for (const action of OWNER_ACTIONS)
        expect(can(role, action), `${String(role)} ${action}`).toBe(false);
    }
  });

  it("ações que não existem no MVP são negadas até ao OWNER (membros, encerrar empresa, timezone)", () => {
    for (const action of [
      "members.invite",
      "members.remove",
      "org.delete",
      "org.close",
      "org.timezone.update",
      "billing.manage",
      "whatsapp.send",
      "",
      "*",
      "org",
      "org.",
      "services", // o grupo sem ação não é uma ação
      "services.", // prefixo sem ação
    ]) {
      expect(can("OWNER", action), action).toBe(false);
    }
  });

  it("curingas só valem para o prefixo exato do grupo", () => {
    expect(can("OWNER", "servicesx.create")).toBe(false);
    expect(can("OWNER", "orgs.view")).toBe(false);
    expect(can("OWNER", "customers.export")).toBe(false); // customers.* não é curinga: só read/write/privacy
  });
});
