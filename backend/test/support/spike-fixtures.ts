import { spikePrisma } from "./databases.ts";

type Spike = ReturnType<typeof spikePrisma>;

export const MIN = 60_000;
export const T0 = new Date("2031-01-01T10:00:00.000Z");
export const at = (minutes: number) => new Date(+T0 + minutes * MIN);

export async function seedOrg(prisma: Spike, name = "A") {
  const org = await prisma.org.create({ data: { name } });
  const [professional, service, customer] = await Promise.all([
    prisma.professional.create({ data: { organizationId: org.id, name: "p" } }),
    prisma.service.create({ data: { organizationId: org.id, name: "s" } }),
    prisma.customer.create({ data: { organizationId: org.id, name: "c" } }),
  ]);
  return { org, professional, service, customer };
}

/** Dados coerentes de um agendamento: ends_at e blocked_until derivados em um único lugar. */
export function appointmentData(
  seed: Awaited<ReturnType<typeof seedOrg>>,
  startMinutes: number,
  duration = 30,
  buffer = 0,
) {
  return {
    organizationId: seed.org.id,
    professionalId: seed.professional.id,
    serviceId: seed.service.id,
    customerId: seed.customer.id,
    startsAt: at(startMinutes),
    endsAt: at(startMinutes + duration),
    blockedUntil: at(startMinutes + duration + buffer),
    durationMinutesSnapshot: duration,
    bufferMinutesSnapshot: buffer,
  };
}
