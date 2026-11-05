import { Shell } from "./lib";

export default function NotFound() {
  return (
    <Shell>
      <section className="card">
        <h1>Page not found</h1>
        <p className="muted">This link isn't valid. Please check it with the business that sent it.</p>
      </section>
    </Shell>
  );
}
