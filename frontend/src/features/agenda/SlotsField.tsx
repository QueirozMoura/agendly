import { Alert, Loading } from "../../components/ui";
import type { Resource } from "../../hooks/useResource";
import { SlotPicker } from "./useSlots";

/** Estados da consulta de horários (carregando / erro / vazio / escolha) para os formulários de criar e remarcar. */
export function SlotsField({
  name,
  resource,
  enabled,
  value,
  onChange,
  onRetry,
  timeZone,
  error,
}: {
  name: string;
  resource: Resource<string[]>;
  enabled: boolean;
  value: string;
  onChange: (slot: string) => void;
  onRetry: () => void;
  timeZone: string;
  error?: string | undefined;
}) {
  return (
    <>
      <SlotsBody
        name={name}
        resource={resource}
        enabled={enabled}
        value={value}
        onChange={onChange}
        onRetry={onRetry}
        timeZone={timeZone}
      />
      {error && <p className="field-error">{error}</p>}
    </>
  );
}

function SlotsBody({
  name,
  resource,
  enabled,
  value,
  onChange,
  onRetry,
  timeZone,
}: Omit<Parameters<typeof SlotsField>[0], "error">) {
  if (!enabled)
    return (
      <p className="muted">
        Escolha profissional, serviço e uma data de hoje em diante para ver os
        horários.
      </p>
    );
  if (resource.status === "loading")
    return <Loading label="Buscando horários…" />;
  if (resource.status === "error")
    return (
      <>
        <Alert kind="error">{resource.message}</Alert>
        <button type="button" className="button" onClick={onRetry}>
          Tentar novamente
        </button>
      </>
    );
  if (resource.data.length === 0)
    return <p className="empty">Nenhum horário disponível neste dia.</p>;
  return (
    <SlotPicker
      name={name}
      slots={resource.data}
      value={value}
      onChange={onChange}
      timeZone={timeZone}
    />
  );
}
