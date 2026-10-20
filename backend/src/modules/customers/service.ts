// Clientes (5): leitura e edição. Editar cliente = N1 (6.5): a linha do cliente é travada e a troca de telefone espera,
// no pior caso, um índice único (folha). Clientes nunca são apagados (R-c): são pais de `appointments`.
import type { PrismaClient, TxClient } from "../../lib/db/client.ts";
import { classifyDbError } from "../../lib/db/errors.ts";
import { lockCustomerById, runLocked } from "../../lib/db/locks/index.ts";
import { forTenant } from "../../lib/db/tenant.ts";
import { AppError } from "../../lib/errors.ts";

export interface CustomerView {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  phoneE164: true,
  email: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

type Row = {
  id: string;
  name: string;
  phoneE164: string;
  email: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const view = (r: Row): CustomerView => ({
  id: r.id,
  name: r.name,
  phone: r.phoneE164,
  email: r.email,
  notes: r.notes,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const notFound = () =>
  new AppError("NOT_FOUND", 404, "Recurso não encontrado.");

export interface CustomerScope {
  organizationId: string;
}

export async function getCustomer(
  prisma: PrismaClient,
  scope: CustomerScope,
  id: string,
): Promise<CustomerView> {
  const row = await forTenant(prisma, scope.organizationId).customer.findUnique(
    {
      where: { id },
      select: SELECT,
    },
  );
  if (!row) throw notFound();
  return view(row);
}

export async function updateCustomer(
  prisma: PrismaClient,
  scope: CustomerScope,
  id: string,
  patch: {
    name?: string | undefined;
    phone?: string | undefined;
    email?: string | null | undefined;
    notes?: string | null | undefined;
  },
): Promise<CustomerView> {
  const data = {
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.phone === undefined ? {} : { phoneE164: patch.phone }),
    ...(patch.email === undefined ? {} : { email: patch.email }),
    ...(patch.notes === undefined ? {} : { notes: patch.notes }),
  };
  try {
    const row = await runLocked(
      forTenant(prisma, scope.organizationId),
      async (tx) => {
        if (
          !(await lockCustomerById(
            tx as unknown as TxClient,
            scope.organizationId,
            id,
          ))
        )
          throw notFound();
        return tx.customer.update({ where: { id }, data, select: SELECT });
      },
    );
    return view(row);
  } catch (err) {
    if (classifyDbError(err) === "unique_violation")
      throw new AppError(
        "CUSTOMER_PHONE_TAKEN",
        409,
        "Já existe um cliente com este telefone.",
      );
    throw err;
  }
}
