import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../../generated/prisma/client.ts";

// Único módulo de src/ que instancia PrismaClient (regra de 4.4). O Prisma 7 exige um driver adapter.
type ClientOptions = NonNullable<ConstructorParameters<typeof PrismaClient>[0]>;

export function createPrismaClient(
  connectionString: string,
  options: Pick<ClientOptions, "log"> = {},
): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    connectionTimeoutMillis: 2000, // não ficar pendurado esperando conexão
    query_timeout: 10_000,
  });
  return new PrismaClient({ adapter, ...options });
}

export type { PrismaClient };
/** Cliente recebido dentro de `prisma.$transaction(async (tx) => …)`. */
export type TxClient = Prisma.TransactionClient;
