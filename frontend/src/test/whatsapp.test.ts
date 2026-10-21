import { describe, expect, it } from "vitest";
// Apenas no teste: o bundle de produção continua independente do backend.
import { normalizePhone as backendNormalizePhone } from "../../../backend/src/lib/phone";
import { normalizePhone } from "../lib/phone";
import {
  appointmentConfirmationKey,
  buildConfirmationMessage,
  buildWhatsAppLink,
  canPrepareWhatsApp,
  type ConfirmationMessageInput,
} from "../lib/whatsapp";
import { makeAppointment } from "./fakeAgenda";

const inputs: Array<[unknown, string | undefined]> = [
  ["(11) 98765-4321", "+5511987654321"],
  ["11 2345-6789", "+551123456789"],
  ["55 11 98765-4321", "+5511987654321"],
  ["+55 (11) 98765-4321", "+5511987654321"],
  ["0055 11 98765-4321", "+5511987654321"],
  ["011987654321", "+5511987654321"],
  ["(55) 98765-4321", "+5555987654321"],
  ["+55 (55) 98765-4321", "+5555987654321"],
  ["+1 (212) 555-0123", "+12125550123"],
  ["0044 20 7946 0958", "+442079460958"],
  ["+351 912 345 678", "+351912345678"],
  ["+81 90 1234 5678", "+819012345678"],
  [undefined, undefined],
  [null, undefined],
  [123456789, undefined],
  ["", undefined],
  ["  ", undefined],
  ["123", undefined],
  ["+0123456789", undefined],
  ["+1234567890123456", undefined],
  ["+55 11 87654-3210", undefined],
  ["+55 10 98765-4321", undefined],
  ["11 1234-5678", undefined],
  ["+55+5511987654321", undefined],
  ["5511987654321 ramal 4", undefined],
  ["https://wa.me/5511987654321", undefined],
  ["+1/2125550123", undefined],
  ["+1 212 555 0123#4", undefined],
];

describe("telefone para WhatsApp", () => {
  it.each(inputs)("normaliza %j para %j", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
  it("mantém compatibilidade com a função existente do backend, sem importá-la em produção", () => {
    const strings = inputs
      .map(([value]) => value)
      .filter((v): v is string => typeof v === "string");
    for (let ddd = 0; ddd < 100; ddd++) {
      const national = `${String(ddd).padStart(2, "0")}987654321`;
      strings.push(
        national,
        `55${national}`,
        `+55${national}`,
        `0055${national}`,
      );
    }
    strings.push(
      " ".repeat(41),
      "1".repeat(41),
      "+55115511987654321",
      "00",
      "++12345678",
    );
    for (const value of strings)
      expect(normalizePhone(value), value).toBe(backendNormalizePhone(value));
  });
});

const messageInput: ConfirmationMessageInput = {
  customerName: "João",
  organizationName: "Espaço Silva",
  serviceName: "Consulta",
  startsAt: "2031-03-04T02:15:00.000Z",
  timeZone: "America/Sao_Paulo",
  status: "SCHEDULED",
};

describe("mensagem manual", () => {
  it("usa dados reais, português e o dia local da empresa", () => {
    expect(buildConfirmationMessage(messageInput)).toBe(
      "Olá, João! 👋\n\nSeu agendamento na Espaço Silva está marcado!\n\n📅 Data: 03/03/2031\n🕒 Horário: 23:15\n📋 Serviço: Consulta\n\nAguardamos você!",
    );
  });
  it("distingue CONFIRMED sem alterar os dados de entrada", () => {
    const input = { ...messageInput, status: "CONFIRMED" as const };
    expect(buildConfirmationMessage(input)).toContain("está confirmado!");
    expect(input.status).toBe("CONFIRMED");
    expect(messageInput.status).toBe("SCHEDULED");
  });
  it.each([
    ["2030-03-09T17:00:00Z", "America/New_York", "09/03/2030", "12:00"],
    ["2030-03-11T16:00:00Z", "America/New_York", "11/03/2030", "12:00"],
    ["2031-03-03T20:00:00Z", "Asia/Kolkata", "04/03/2031", "01:30"],
  ])(
    "respeita fuso e horário de verão em %s, %s",
    (startsAt, timeZone, day, time) => {
      const message = buildConfirmationMessage({
        ...messageInput,
        startsAt,
        timeZone,
      });
      expect(message).toContain(`Data: ${day}`);
      expect(message).toContain(`Horário: ${time}`);
    },
  );
  it("omite informações ausentes, sem undefined, endereço, preço ou profissional inventado", () => {
    const message = buildConfirmationMessage({
      startsAt: messageInput.startsAt,
      timeZone: messageInput.timeZone,
      status: "SCHEDULED",
    });
    expect(message).toContain("Olá! 👋\n\nSeu agendamento está marcado!");
    expect(message).not.toMatch(
      /undefined|null|Serviço:|Endereço:|Profissional:|Preço:/,
    );
  });
  it("mantém nomes com quebra de linha em uma linha", () => {
    expect(
      buildConfirmationMessage({
        ...messageInput,
        customerName: "João\nSilva",
      }),
    ).toContain("Olá, João Silva!");
  });
  it("recusa data e fuso inválidos", () => {
    expect(
      buildConfirmationMessage({ ...messageInput, startsAt: "inválido" }),
    ).toBeNull();
    expect(
      buildConfirmationMessage({ ...messageInput, timeZone: "fuso/inválido" }),
    ).toBeNull();
  });
  it.each(["CANCELLED", "COMPLETED", "NO_SHOW"] as const)(
    "não confirma %s",
    (status) => {
      expect(buildConfirmationMessage({ ...messageInput, status })).toBeNull();
      expect(canPrepareWhatsApp({ ...messageInput, status }, 0)).toBe(false);
    },
  );
  it("não prepara agendamentos passados, no instante atual ou inválidos", () => {
    const now = new Date(messageInput.startsAt).getTime();
    expect(canPrepareWhatsApp(messageInput, now - 1)).toBe(true);
    expect(canPrepareWhatsApp(messageInput, now)).toBe(false);
    expect(canPrepareWhatsApp(messageInput, now + 1)).toBe(false);
    expect(
      canPrepareWhatsApp({ ...messageInput, startsAt: "inválido" }, now),
    ).toBe(false);
  });
  it("invalida a identidade quando qualquer dado do agendamento muda", () => {
    const a = makeAppointment("a1", "p1", messageInput.startsAt);
    for (const patch of [
      { version: a.version + 1 },
      { startsAt: "2031-03-04T12:00:00Z" },
      { updatedAt: "2031-03-02T12:00:00Z" },
      { status: "CONFIRMED" as const },
      { customer: { ...a.customer, name: "Outro" } },
      { service: { ...a.service, name: "Outro serviço" } },
    ])
      expect(appointmentConfirmationKey({ ...a, ...patch })).not.toBe(
        appointmentConfirmationKey(a),
      );
    // Uma ordem diferente de chaves no JSON não é mudança de dados.
    expect(
      appointmentConfirmationKey({
        ...a,
        customer: { name: a.customer.name, id: a.customer.id },
      }),
    ).toBe(appointmentConfirmationKey(a));
  });
});

describe("link oficial", () => {
  it("usa apenas dígitos e encodeURIComponent, com caracteres especiais preservados", () => {
    const message = "Olá, João! 👋\nServiço: Corte & barba #1? 100%";
    const link = buildWhatsAppLink("+55 (11) 98765-4321", message);
    expect(link).toBe(
      `https://wa.me/5511987654321?text=${encodeURIComponent(message)}`,
    );
    expect(new URL(link as string).searchParams.get("text")).toBe(message);
  });
  it("preserva o DDI estrangeiro e não gera link sem destinatário ou mensagem", () => {
    expect(buildWhatsAppLink("+442079460958", "Olá")).toBe(
      `https://wa.me/442079460958?text=${encodeURIComponent("Olá")}`,
    );
    expect(buildWhatsAppLink(undefined, "Olá")).toBeNull();
    expect(buildWhatsAppLink("inválido", "Olá")).toBeNull();
    expect(buildWhatsAppLink("+5511987654321", " ")).toBeNull();
  });
});
