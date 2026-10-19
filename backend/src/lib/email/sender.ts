export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Contrato com o provedor de e-mail (3.5). O provedor real é escolhido depois (V10); o núcleo só conhece isto. */
export interface EmailSender {
  /** Deve respeitar `signal` (timeout). Lançar EmailSendError(permanent=true) só para falhas definitivas. */
  send(message: EmailMessage, options: { signal: AbortSignal }): Promise<void>;
}

export class EmailSendError extends Error {
  /** true: não adianta tentar de novo (ex.: destinatário rejeitado em definitivo). */
  readonly permanent: boolean;
  constructor(message: string, permanent = false) {
    super(message);
    this.name = "EmailSendError";
    this.permanent = permanent;
  }
}

/** Implementação de captura: guarda as mensagens em memória (testes). */
export class CaptureEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/**
 * Desenvolvimento: imprime a mensagem no terminal, INCLUINDO o link com o token (sem provedor real é a única
 * forma de concluir os fluxos). Por isso nunca é usada em produção (ver start.ts).
 */
export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.info(
      `\n--- e-mail (console, só desenvolvimento) ---\nPara: ${message.to}\nAssunto: ${message.subject}\n\n${message.text}\n---`,
    );
  }
}
