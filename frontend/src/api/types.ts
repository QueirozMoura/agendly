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
