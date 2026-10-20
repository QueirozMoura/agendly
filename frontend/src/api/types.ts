// Contrato HTTP consumido pelo frontend. Escrito à mão (o frontend nunca importa código do backend, seção 2).

export interface ApiUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export interface ApiOrganization {
  name: string;
  /** Identifica a empresa para o cliente; o id interno nunca sai da API. */
  slug: string;
  timezone: string;
  status: string;
  publishedAt: string | null;
  publicMinNoticeMinutes: number;
  publicMaxAdvanceDays: number;
  publicMaxActiveBookingsPerPhone: number;
  createdAt: string;
  role: string;
}

export interface OrganizationsResponse {
  organizations: ApiOrganization[];
  activeSlug: string | null;
}

export interface MessageResponse {
  message: string;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export interface ApiService {
  id: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  priceCents: number | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiProfessional {
  id: string;
  name: string;
  active: boolean;
  /** Conjunto COMPLETO de serviços vinculados (o `PUT` substitui tudo). */
  serviceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiWorkingHours {
  id: string;
  professionalId: string;
  /** 0 = domingo ... 6 = sábado. */
  weekday: number;
  /** "HH:mm" (hora local da empresa); `endTime` pode ser "24:00". */
  startTime: string;
  endTime: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiTimeOff {
  id: string;
  professionalId: string;
  /** Instantes ISO 8601 em UTC. */
  startsAt: string;
  endsAt: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `details` do 409 de R4: agendamentos ativos afetados por uma folga/alteração de expediente (nada foi alterado). */
export interface ConflictDetails {
  conflicts: Array<{
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    customer: { id: string; name: string };
    serviceName: string;
  }>;
  /** Total REAL; `conflicts` traz no máximo 100. */
  totalCount: number;
  truncated: boolean;
}
