// Aplica o tema salvo ANTES da primeira pintura (evita o flash do tema errado). Arquivo próprio, carregado de forma
// síncrona no <head>: funciona com uma CSP `script-src 'self'`, sem script inline. A chave e os valores devem coincidir
// com src/lib/theme.ts (há um teste para isso). "sistema" não grava nada: o CSS segue prefers-color-scheme.
/* global document */
(function () {
  try {
    var t = localStorage.getItem("agendly-theme");
    if (t === "light" || t === "dark")
      document.documentElement.setAttribute("data-theme", t);
  } catch {
    // armazenamento indisponível: fica no tema do sistema
  }
})();
