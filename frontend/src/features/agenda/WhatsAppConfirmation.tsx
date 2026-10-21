import { useEffect, useId, useRef, useState } from "react";
import { useApi } from "../../api/ApiContext";
import type {
  ApiAppointment,
  ApiCustomer,
  ApiOrganization,
} from "../../api/types";
import { Alert, Loading } from "../../components/ui";
import { useResource } from "../../hooks/useResource";
import {
  appointmentConfirmationKey,
  buildConfirmationMessage,
  buildWhatsAppLink,
  canPrepareWhatsApp,
} from "../../lib/whatsapp";
import { useOrganizations } from "../organizations/OrganizationContext";

export function WhatsAppConfirmation({
  appointment,
  revision,
}: {
  appointment: ApiAppointment;
  revision: number;
}) {
  const { active } = useOrganizations();
  if (!active || !canPrepareWhatsApp(appointment)) return null;
  // Uma mudança de contexto desmonta todo o estado ANTES de exibir os novos dados.
  const key = JSON.stringify([
    active.slug,
    active.name,
    active.timezone,
    active.role,
    active.status,
    appointmentConfirmationKey(appointment),
    revision,
  ]);
  return (
    <Confirmation key={key} appointment={appointment} organization={active} />
  );
}

function Confirmation({
  appointment,
  organization,
}: {
  appointment: ApiAppointment;
  organization: ApiOrganization;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const id = useId();
  useEffect(() => {
    if (!open && wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  // Ao voltar de outra aba, exige nova preparação, sem reutilizar dados antigos.
  useEffect(() => {
    if (!open) return;
    const closeWhenHidden = () => {
      if (document.hidden) setOpen(false);
    };
    document.addEventListener("visibilitychange", closeWhenHidden);
    return () =>
      document.removeEventListener("visibilitychange", closeWhenHidden);
  }, [open]);
  if (!open)
    return (
      <div className="row-actions whatsapp-action">
        <button
          ref={trigger}
          type="button"
          className="button"
          aria-expanded={false}
          aria-controls={id}
          onClick={() => setOpen(true)}
        >
          Preparar confirmação pelo WhatsApp
        </button>
      </div>
    );
  return (
    <Preview
      id={id}
      appointment={appointment}
      organization={organization}
      onClose={() => setOpen(false)}
    />
  );
}

function Preview({
  id,
  appointment,
  organization,
  onClose,
}: {
  id: string;
  appointment: ApiAppointment;
  organization: ApiOrganization;
  onClose: () => void;
}) {
  const api = useApi();
  const panel = useRef<HTMLElement>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    panel.current?.focus();
  }, []);
  useEffect(() => {
    if (!canPrepareWhatsApp(appointment, now)) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(
        Math.max(new Date(appointment.startsAt).getTime() - now, 0),
        2_147_483_647,
      ),
    );
    return () => clearTimeout(timer);
  }, [appointment.startsAt, now]);
  const { resource, reload } = useResource(
    async (signal) => {
      // Revalida a seleção: uma atualização remota já conhecida pelo servidor não vira mensagem antiga.
      const { appointment: current } = await api.request<{
        appointment: ApiAppointment;
      }>("GET", `/api/appointments/${encodeURIComponent(appointment.id)}`, {
        signal,
      });
      if (
        appointmentConfirmationKey(current) !==
        appointmentConfirmationKey(appointment)
      )
        return { kind: "stale" as const };
      const { customer } = await api.request<{ customer: ApiCustomer }>(
        "GET",
        `/api/customers/${encodeURIComponent(current.customer.id)}`,
        { signal },
      );
      if (customer.id !== current.customer.id)
        return { kind: "invalid" as const };
      const message = buildConfirmationMessage({
        customerName: customer.name,
        organizationName: organization.name,
        serviceName: current.service.name,
        startsAt: current.startsAt,
        timeZone: organization.timezone,
        status: current.status,
      });
      const link = message && buildWhatsAppLink(customer.phone, message);
      return message && link
        ? { kind: "ready" as const, message, link }
        : { kind: "invalid" as const };
    },
    [api, appointment, organization],
  );
  const eligible = canPrepareWhatsApp(appointment, now);
  return (
    <section
      id={id}
      className="whatsapp-preview"
      ref={panel}
      tabIndex={-1}
      aria-label="Prévia da confirmação pelo WhatsApp"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <p>Confira a mensagem. Você precisará confirmar o envio no WhatsApp.</p>
      {!eligible ? (
        <Alert kind="info">
          O horário deste agendamento já passou. Atualize a agenda.
        </Alert>
      ) : resource.status === "loading" ? (
        <Loading label="Preparando confirmação…" />
      ) : resource.status === "error" ? (
        <>
          <Alert kind="error">{resource.message}</Alert>
          <button type="button" className="button" onClick={reload}>
            Tentar novamente
          </button>
        </>
      ) : resource.data.kind === "stale" ? (
        <Alert kind="info">
          Este agendamento foi atualizado. Atualize a agenda antes de preparar a
          confirmação.
        </Alert>
      ) : resource.data.kind === "invalid" ? (
        <Alert kind="info">
          Não foi possível preparar a confirmação. Confira o telefone do cliente
          e os dados do agendamento.
        </Alert>
      ) : (
        <>
          <p className="whatsapp-message">{resource.data.message}</p>
          <a
            className="button"
            href={resource.data.link}
            target="_blank"
            rel="noopener noreferrer"
            aria-describedby={`${id}-manual`}
            onClick={(event) => {
              if (!canPrepareWhatsApp(appointment)) {
                event.preventDefault();
                setNow(Date.now());
              }
            }}
          >
            Enviar confirmação pelo WhatsApp
          </a>
          <p id={`${id}-manual`} className="muted">
            Abre o WhatsApp em outra aba ou aplicativo. Nenhuma mensagem é
            enviada automaticamente.
          </p>
        </>
      )}
      <div className="row-actions">
        <button type="button" className="button" onClick={onClose}>
          Fechar prévia
        </button>
      </div>
    </section>
  );
}
