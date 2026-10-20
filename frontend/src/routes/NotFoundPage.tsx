import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <section className="page card">
      <h1>Página não encontrada</h1>
      <p>O endereço que você abriu não existe.</p>
      <Link to="/">Voltar ao início</Link>
    </section>
  );
}
